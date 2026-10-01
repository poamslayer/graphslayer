# Cloudflare's production code-mode MCP server, read as a reference

Research note, 2026-09-16. Cloudflare runs a public MCP server for its own API at `mcp.cloudflare.com`, and the source is public under Apache-2.0 at [github.com/cloudflare/mcp](https://github.com/cloudflare/mcp). It is a code-mode server over about 2,500 endpoints, which is the same shape of problem as Microsoft Graph. This note records what the code does, what we take from it, and where we differ. It also records a local spike that proved the same sandbox runs on a laptop.

## What the server does

Three tools are exposed. Their definitions cost about 1,100 tokens in total, against about 244,000 tokens when the same server registers one tool per endpoint.

- `search`. The model writes a JavaScript function over a `spec` object. The server bakes a pre-processed OpenAPI spec into a fresh isolate, runs the function, and returns the result ([src/tools/search.ts](https://github.com/cloudflare/mcp/blob/main/src/tools/search.ts)).
- `execute`. The model writes a JavaScript function that calls `cloudflare.request({ method, path, query, body })`. The function runs in a fresh isolate whose outbound fetch goes through a proxy that allows one hostname and injects the API token ([src/tools/execute.ts](https://github.com/cloudflare/mcp/blob/main/src/tools/execute.ts)).
- `docs`. Searches Cloudflare's developer documentation.

Other mechanics worth knowing:

- The spec processor inlines every `$ref` and keeps only summary, description, tags, parameters, request body, and responses per operation ([src/spec-processor.ts](https://github.com/cloudflare/mcp/blob/main/src/spec-processor.ts)). The processed spec is stored in R2 and refreshed daily by a scheduled job.
- A fresh isolate is created per call because dynamic worker isolates do not allow `eval`, so the model's code is placed into the module source.
- Output is cut at 6,000 tokens with a message that tells the model to narrow its query ([src/truncate.ts](https://github.com/cloudflare/mcp/blob/main/src/truncate.ts)).
- `execute` allows writes. Its description says "read, create, update, or delete". The gate is the OAuth permission set the person selects at consent time.
- A `?codemode=false` query parameter switches the server to one tool per endpoint, served from a precomputed artifact with raw request handlers so the server does not build 2,500 closures per request ([src/tools/non-codemode.ts](https://github.com/cloudflare/mcp/blob/main/src/tools/non-codemode.ts)).
- Account selection is injected into the isolate as a constant. When the token spans several accounts and none is chosen, reading `accountId` throws a clear error instead of producing a bad path.

## What we take from it

- The three-tool shape and the tiny tool definition budget. Our `graph_run` is their `execute` with a typed binding instead of a raw request function.
- Search as code over a processed spec, rather than a fixed lookup. Plan 2 changes `graph_describe` to accept a script over a compact Graph index, with a plain query shortcut. The spec processor's approach to inlining references and dropping everything but the fields a caller needs is the model for our index build. Graph's raw OpenAPI file is 44 MB, so the compaction step matters more for us.
- The token never enters the isolate. Their outbound proxy holds it; our Node service binding holds it.
- The truncation message wording.
- The pattern of a constant that throws when unresolved, for tenant selection if we ever allow a run without an explicit tenant.

## Where we differ

- Writes. Their `execute` can write; our sandbox cannot, and writes go through a separate tool with a dry run and a confirm token. Decision record 0001 records why.
- Transport. Theirs is hosted only. Ours is local first with the same runtime, and hosted later. Decision record 0002.
- Per-call tenant. Theirs resolves an account per session or token. Ours takes a tenant argument on every call. Decision record 0004.

## The permission model, read for the policy-engine decision

Re-read on 2026-09-16 to answer what Cloudflare does about write defaults, because our spec proposes a policy file and theirs has none.

**There is no policy file.** The only gate on a write is the OAuth scope set the person picked at consent, enforced by Cloudflare's own API rather than by the server. The server ships two named templates and nothing between them ([src/auth/scopes.ts](https://github.com/cloudflare/mcp/blob/main/src/auth/scopes.ts)):

- `read-only`, the default, commented "read-only is safest".
- `full-access`, "Every OAuth scope available to the MCP server. Use with trusted clients only."

Three details are worth taking:

- **The read-only set is derived, not curated.** `isReadOnlyScope` splits a scope name on `:` or `.` and keeps it when the last segment is `read`, `metadata_read`, `monitoring` or `report`. Over the 381 scopes in `derived-oauth-scopes.json` that classifies 191 read and 190 write. Nobody maintains a list.
- **`destructiveHint: true` is static.** `execute` carries `readOnlyHint: false, destructiveHint: true, openWorldHint: true` in both templates, so a client cannot tell a read-only session from a full-access one by annotation. The annotation describes the tool, not the session.
- **No confirmation of any kind.** Grepping every `src/**/*.ts` for dry run, confirm token, elicitation or approval returns nothing. Consent is the only human moment in the whole write path.

### Why we still want a second gate

Their model collapses our policy engine and our consent step into one thing. That works for them and does not transfer cleanly, for one structural reason: **Cloudflare's users write to their own account; ours write to someone else's tenant.**

Scope granularity is the specific gap. `access-group.write` authorises writes to every Access group in the account, and Graph's `Group.ReadWrite.All` authorises writes to every group in the tenant. Neither scope system can express "only this group", because neither is resource-scoped. For a consultant holding a client's tenant, "you may change only these three break-glass accounts" is the restriction that actually matters, and there is nowhere but a policy file to put it.

This is also the answer ADR-0001 could not give. Its rejected option was "Both paths. Two enforcement points to keep consistent, for a benefit we could not name." The benefit is now nameable: resource-id restriction that no scope can carry.

### What we take from it

- **Derive the preset, do not curate it.** Their `isReadOnlyScope` heuristic is the model for building our policy presets from the index's `methods` field, which every one of our 11,546 paths already carries. A preset nobody maintains cannot drift.
- **Two templates, not many.** Our first instinct was a hand-written list of task-shaped presets (group members, user licences, device removal). Cloudflare shipped two and stopped.

## Local spike: the same sandbox on a laptop

The Worker Loader is a Cloudflare runtime feature, but the runtime itself, `workerd`, is open source and on npm, and Miniflare is the Node library that drives it. On 2026-09-16 we ran a spike in a scratch directory with Miniflare 4.20260730.0 and `workerd` 1.20260915.1 on macOS.

Setup: a host worker with a `workerLoaders: { LOADER: {} }` binding creates a fresh isolate per run, places the model's code into the module source, and sets the isolate's `globalOutbound` to a service binding that is a plain Node function. The Node function is where our Graph client would live.

| Check | Result |
|---|---|
| Return a value from a script | Works. First run 52 ms including warm-up, later runs 2 to 10 ms. |
| Script calls the binding, Node function answers | Works. The Node function saw the path the script asked for. |
| Two binding calls in parallel with `Promise.all` | Works. |
| Script fetches another hostname | Never leaves the process. The Node function refused it. |
| Script throws | Reported with name and message. |
| `typeof process`, `typeof require` in the script | Both `undefined`. |
| `console.log` capture | Works with a shim in the sandbox module. |
| Infinite loop | Wedges the whole `workerd` process. Later runs also hang. Local `workerd` does not enforce a CPU limit. |
| Unbounded allocation | Same. Local `workerd` did not stop it within 20 seconds. |
| Dispose Miniflare and create a new instance after a hang | Dispose took 2 ms, new instance plus first run 30 ms. No orphaned `workerd` process was left. |
| Install size | 169 MB in `node_modules`, 109 MB of it the `workerd` binary. |

Conclusion: the sandbox works locally with the same code path Cloudflare uses in production. The one gap is CPU and memory limits, which the server closes with a Node-side deadline that disposes and recreates the runtime, plus item and result caps in the Graph client. The Code Mode SDK itself ships only a Workers executor and a browser iframe executor, so we drive Miniflare directly rather than using the SDK.

## Sources

- https://github.com/cloudflare/mcp (Apache-2.0, pushed 2026-09-10)
- https://github.com/cloudflare/mcp/blob/main/src/tools/search.ts
- https://github.com/cloudflare/mcp/blob/main/src/tools/execute.ts
- https://github.com/cloudflare/mcp/blob/main/src/spec-processor.ts
- https://github.com/cloudflare/mcp/blob/main/src/tools/non-codemode.ts
- https://github.com/cloudflare/mcp/blob/main/src/truncate.ts
- https://github.com/cloudflare/agents/blob/main/packages/codemode/src/executor.ts (Code Mode SDK executors)
- https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare (Miniflare, `workerLoaders` option and Node-function service bindings)
- https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
- https://developers.cloudflare.com/agents/model-context-protocol/codemode/
