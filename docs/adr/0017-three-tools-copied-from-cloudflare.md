# Three tools, copied from Cloudflare: docs, search, execute

The server's tools are now `docs`, `search` and `execute`, the three Code Mode tools of Cloudflare's MCP server (`cloudflare/mcp`, read 2026-10-01), plus the connection tools. `execute` reads and writes, and there is no separate write tool, no dry run and no confirm token. Arnold chose this on 2026-10-01 (#78): "they are super secure, they know more than me." Copying the reference whole is the decision. Partial copies were the alternatives, and they were rejected.

## The tools

| Tool | What it does | Was |
|---|---|---|
| `docs` | Searches Microsoft Learn through Microsoft's public Learn MCP server (`learn.microsoft.com/api/mcp`, tool `microsoft_docs_search`). It returns passages with their title and link. It needs no key. | New |
| `search` | Runs a script over the shipped Graph index in the no-network sandbox (ADR-0008). Code only, as Cloudflare's `search` is. | `graph_describe`, which also had a keyword query mode |
| `execute` | Runs a script against one tenant. `graph.request({ method, path, body })` writes, the same shape as Cloudflare's `cloudflare.request()`. | `graph_run` (reads only) and `graph_write` |

`tools/list` went from about 4,211 tokens for six tools to about 3,299 tokens for six tools, with `docs` added. Both were measured as characters divided by four on 2026-10-01.

## How a write is limited now

The only limit is the connection's mode (ADR-0012). A connection added in read mode refuses every method but GET, inside the binding, before anything is sent, and the message names the way to make that kind of connection writable. That is the role Cloudflare's consent screen plays for its `execute`: a person picks the permission set once, and nothing asks again per call. Graph still refuses a write that the granted scopes do not cover.

The Graph client now resends a write only on 429. A 503 or 504 on a POST can arrive after Graph applied the write, and resending it could create the object twice. A `$batch` made only of GETs is still resent.

## What this supersedes

- **ADR-0001** (the read-only sandbox with writes in a separate tool) is reversed. The binding writes.
- **ADR-0005** (the dry run and the server-signed confirm token) is withdrawn. `confirm-token.ts`, `write-preview.ts`, `validate-body.ts` and `graph_write` are gone.
- **ADR-0015's line that "a person still confirms every write"** is no longer true. The agent connection's mode is its only limit, as for every other kind.

## What is given up

- **A script that reads tenant data can now write in the same run.** Before, text planted in a tenant (a group description or a user's display name written as an instruction) could reach the model, but nothing inside a run could act on it. Now a write connection's run can. Cloudflare accepts the same exposure.
- **Nothing previews a write before it happens.** The model sees what Graph answered, after the fact. The record of the change is the workload's audit log (ADR-0016).
- **Clients cannot gate writes by tool name.** `execute` carries `destructiveHint: true` for every call, including reads, because MCP annotations are per tool and not per call. A client that prompts on destructive tools now prompts for reads too.
- **`search` lost its keyword mode** and the curated answer it gave: ranked matches, enum values, and a note where Microsoft's permission reference is silent. The same facts are in the index, and the description shows how to get them with a script. On GCC High, the description says the scopes are commercial and unverified (ADR-0014), which the query mode used to say per result.
