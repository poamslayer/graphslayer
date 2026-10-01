# Design: a Microsoft Graph MCP server with server-side code mode

Date: 2026-09-15
Status: approved in discussion, not yet implemented
Related: `docs/research/lokka-vs-mcp-design-principles.md`

## What this is

This is the design for an open source Model Context Protocol (MCP) server for Microsoft Graph. It gives an AI agent the same reach as Lokka, which is the existing open source Graph MCP server, and fixes the problems the research note found in Lokka. The main idea is "code mode". Instead of exposing one generic request tool, the server exposes a sandbox in which the model writes a short script against a typed, guarded Graph client. The script filters and joins data before anything returns to the model, so the model only reads the result it asked for.

The project is a personal open source project. It does not belong to either consulting venture.

## Decisions made during design

These were decided in discussion and are fixed for version 1.

| Question | Decision |
|---|---|
| Read and write scope | Full parity with Lokka. Any Graph endpoint can be read and any can be written. |
| Where the generic write path lives | In a separate write tool. The sandbox script is read-only. |
| How version 1 ships | A local process started with one `npx` line, the same install story as Lokka. |
| Hosting | A self-hosted Cloudflare Worker is planned for version 2. The core is written so the Worker is a second transport, not a rewrite. |
| Sandbox runtime | Cloudflare's `workerd`, driven through Miniflare, so the local and hosted versions share one sandbox. Chosen over QuickJS in WebAssembly after reading Cloudflare's production server and running a local spike. |
| Sign-in to the server | Not needed in version 1 because the process is local and single-user. |
| Graph credentials | Delegated by default. A person signs in through the browser. App-only with a certificate or secret is supported as an opt-in. |
| Default sign-in app | The Microsoft Graph Command Line Tools public client, application id `14d82eec-204b-4c2f-b7e8-296a70dab67e`. Microsoft Learn lists it as a Microsoft tenant-owned application. A deployer can replace it with their own app id in config. |

## Why code mode fits Graph

The research note measured Lokka's biggest cost as the size of responses, not the size of tool definitions. A default page of one hundred users costs about ten thousand tokens the way Lokka formats it, and fetching every page in a five thousand user tenant costs about half a million tokens in one tool result. Code mode removes this cost at the source. The script receives the full response inside the sandbox, keeps the fields and rows it needs, and returns only those.

The note also lists the queries Lokka markets, e.g., conditional access policies that do not exclude the break glass accounts. Each of those needs several Graph calls and a join. With code mode the model writes the join once and makes one tool call.

Code mode is normally a feature of the client, not the server. Claude Code does not have it, and the Claude API's programmatic tool calling does not work with MCP tools. So the server has to provide it. Cloudflare documents this exact server-side pattern, and this design follows it.

## What code mode loses and how this design gets it back

A single "run this script" tool hides what the script does from the client. The client cannot tell a read from a delete, cannot prompt for confirmation, and cannot audit individual steps. This design handles each of those.

- The sandbox binding is read-only. It has no write methods at all. A script cannot change anything in a tenant.
- Writes go through one separate tool that is annotated as destructive. Clients that prompt on destructive tools will prompt. Clients that do not prompt still hit the server's own confirmation step, described below.
- Every Graph call the script makes is written to the audit log as its own line, so the audit is per call, not per script.
- The sandbox has no network, no filesystem, and no environment. If tenant data contains text that tricks the model into writing code that sends data somewhere, the code has nowhere to send it.

## Architecture

Version 1 is one TypeScript package. The core does not know which transport it runs under. The only transport in version 1 is stdio.

The core has six units. Each has one job, a small interface, and its own tests.

### Connections

A connection is one signed-in identity for one tenant. It stores the tenant id, the tenant display name, the account that signed in, the client id used, whether it is delegated or app-only, and the scopes granted. This metadata lives in a JSON file under the user's home directory. Secrets, certificate passwords, and the token cache live in the operating system keychain and never in a file.

Every tool that touches Graph takes a `tenant` argument. The argument is the tenant id or a short alias set when the connection was added. There is no "active connection" that a tool switches. This makes each call auditable on its own and lets one agent turn touch two tenants on purpose.

### Graph client

The Graph client is the one place that makes HTTP requests to Graph. It applies these rules in code, so the model never has to remember them.

- The default API version is `v1.0`. A call can ask for `beta` explicitly. The result says which version ran.
- When a query uses `$filter`, `$search`, `$orderby`, or `$count` on a directory object, the client sets the `ConsistencyLevel: eventual` header and adds `$count=true`, because Microsoft requires this for advanced queries.
- When the caller does not pass `$select` and the resource is in the Graph index, the client applies the default select for that resource.
- On a 429 or 503 response the client waits for the number of seconds in the `Retry-After` header and retries, within a total budget per tool call.
- Results are compact JSON. The client never pretty prints.
- Every result carries the tenant, the API version, and the request id from Graph.

### Graph index

The Graph index is a compact JSON file built offline and shipped inside the package. Paths come from Microsoft's published OpenAPI description, entity types and their property types come from the CSDL metadata the OpenAPI is generated from, and permissions come from the permissions reference. For each resource path it records the entity type, whether advanced queries need the consistency header, the default `$select`, and the least privileged delegated and application permissions. Property types live in a shared `types` table that paths reference by entity type name.

The shared type table is not a preference, it is the only shape that works. Inlining every `$ref` the way Cloudflare's spec processor does cannot be done on Graph: `/users` alone exceeds 64 MB once inlined, and the whole v1.0 description projects to about 16 GB, because every directory object reaches `microsoft.graph.entity` and drags the transitive closure with it. The CSDL is preferred over the OpenAPI schemas for types because it is 3.6 MB against 44 MB, yields a tighter table for the same paths (3,034 types against 5,187), and joins at 99.9%.

Measured sizes: about 16 MB for v1.0 and 26 MB for beta. Prototype and full numbers are on issue #14 and the `prototype/graph-index` branch.

The server searches this index locally to answer the describe tool and to help map a 403 to the permission that is missing, alongside Graph's own error body. A build script regenerates the index, and regenerating it is part of the release process. Two things constrain that script. Graph's OpenAPI ships only as YAML and a JavaScript YAML parser cannot load it — 44 MB exhausts an 8 GB heap — so the build converts to JSON with a C-backed parser first and then uses the native JSON parser. And the build peaks around 900 MB of memory, so it runs on a machine at release time, never in a Worker.

### Scope templates and connection mode

There is no policy engine. A connection is added under one of two scope templates, read or read-write, and carries a mode that says which. The write tool refuses before building a request when the connection's mode is read. ADR-0012 records why, and `docs/research/cloudflare-mcp-code-mode-reference.md` records the Cloudflare server this follows.

A template is a list of scopes to ask for at sign-in, not a rule the server enforces. Entra caps a consent request at about 155 delegated permissions and about 300 application permissions, and the index holds 635 distinct scopes, 281 of them read, so the shipped read set is chosen by hand from a mechanically ranked shortlist rather than derived whole. Scope names classify themselves: a name carrying `ReadWrite`, `Write`, `Manage`, `Create`, `Delete`, `Send` and similar is a write. Thirty-six names classify as neither, `Directory.AccessAsUser.All` among them, and every one of those counts as a write so that a misreading keeps it out of the read template.

The mode is what enforces, because the template cannot. Entra returns every scope previously consented for the resource whatever a request asks for, consent belongs to the application and tenant rather than to our connection, and `src/core/auth/msal.ts` acquires every token after sign-in with `https://graph.microsoft.com/.default`. A connection's token is therefore routinely wider than the scopes it was created with.

App-only connections get no template. The client credentials flow must request `.default`, so an app-only connection takes whatever an administrator granted the registration, and mode is the only control on that path.

### Sandbox

The sandbox runs the model's script in a fresh V8 isolate created by the Worker Loader inside `workerd`, Cloudflare's open source Workers runtime. The server starts and drives `workerd` through Miniflare, the Node library made for that. Each run gets a new isolate. The isolate has no filesystem, no environment variables, and no `process` or `require`. Its only network path is a service binding that resolves to a Node function inside our server, so every `fetch` the script makes lands in that function and nowhere else. The function is where the Graph client lives, so the token never enters the isolate. This is the same mechanism Cloudflare's own production MCP server uses, and the hosted version of this server will use the same Worker Loader on Cloudflare Workers, so one sandbox implementation serves both. See `docs/research/cloudflare-mcp-code-mode-reference.md` for the reference and the local spike that proved it.

The Graph binding is exposed to the script as functions that return promises, so the model writes `await graph.list(...)`. Several binding calls may be in flight at once. For many small requests the binding also offers a batch helper that sends up to twenty requests in one Graph `$batch` call.

The script is the body of an async function. The server wraps it, so the model writes `return` to hand back its result.

Local `workerd` does not enforce CPU or memory limits. The server enforces a wall-clock deadline from the Node side. When a run exceeds it, the server abandons the run, disposes the Miniflare instance, and creates a new one on the next run, which takes about thirty milliseconds. Item counts and result size are capped in the Graph client and the output helper, not in the isolate.

### Audit

The audit log is newline-delimited JSON, one file per day, under the user's home directory. Each line records the timestamp, tenant, principal, tool name, HTTP method, path, query, a hash of the request body, the response status, the duration, and for scripts a hash of the script text. A write records its preview as well: the field diff for a PATCH, the removed object for a DELETE, the validated body for a POST or PUT. A hash proves something changed and cannot say what, and "what did your tool change in my directory" is a question a tenant owner will ask. The preview is already computed for the confirm step, so this costs one field and puts real tenant values in the log, which is why the file is written `0600` inside a `0700` directory. Each Graph call made inside a script is its own line. The log path is configurable.

## Tool surface

Six tools plus five task tools ship in version 1. Every tool declares an output schema and returns structured content. Read tools set `readOnlyHint: true`. The write tool sets `destructiveHint: true`.

`graph_write` is always registered, whether or not any connection can currently write, so the tool list does not change under a running session. A call against a read connection is refused by the mode check with a message naming the connection. Cloudflare registers its own write tool unconditionally for the same reason, and has no equivalent local check.

### graph_run

Arguments: `tenant` and `code`.

The tool runs `code` in the sandbox against the tenant's connection and returns the script's return value, anything the script logged, and a list of the Graph calls it made. Output is capped at about ten thousand tokens. When the cap is hit the output is cut and the result carries a `truncated: true` flag and a note telling the model to narrow the script.

The binding the script sees:

```ts
declare const graph: {
  // One object, e.g. await graph.get("/users/{id}", { select: ["displayName"] })
  get(path: string, opts?: QueryOpts): Promise<unknown>;
  // One page. Returns { items, nextCursor }. Default top is 50, max is 999.
  // Pass opts.cursor to fetch the next page.
  list(path: string, opts?: QueryOpts): Promise<Page>;
  // Every page up to opts.max items (default 2000, hard cap 20000). Items stay in the sandbox.
  all(path: string, opts?: QueryOpts & { max?: number }): Promise<unknown[]>;
  // Up to 20 requests in one Graph $batch call. Returns results in order.
  batch(requests: Array<{ path: string; opts?: QueryOpts }>): Promise<unknown[]>;
  // Count with $count=true and the consistency header set for you.
  count(path: string, filter?: string): Promise<number>;
};

interface QueryOpts {
  select?: string[];
  filter?: string;
  expand?: string[];
  orderby?: string;
  search?: string;
  top?: number;
  beta?: boolean;
  cursor?: string;
}

interface Page {
  items: unknown[];
  nextCursor?: string;
}
```

Limits enforced per run: a memory limit of 64 MB, a deadline of 60 seconds, and a maximum of 200 Graph calls. The retry budget for throttling counts toward the deadline.

### graph_describe

Arguments: `query` or `code`, one of the two.

With `query`, the tool searches the Graph index for a resource name, a path fragment, or a property name and returns the matching endpoints, the entity's properties and types, the default select, the least privileged permissions, and one example call for the run tool.

With `code`, the tool runs a JavaScript function in the sandbox with the Graph index available as an `index` object and no network at all, and returns what the function returns. The sandbox it runs in is built without the Graph service binding, so the absence of network is a property of that sandbox rather than something the caller has to remember; see ADR-0008. This is the pattern Cloudflare's production server uses for its 2,500 endpoints, and it lets the model ask any question of the index without the server predicting the question. The index must therefore fit inside an isolate, which is a hard constraint on the index build. `workerd` refuses a dynamic worker whose module source exceeds `MAX_DYNAMIC_WORKER_CODE_SIZE`, a constant compiled into the binary at 64 MiB, so the same limit applies to the hosted transport. Measured usable budget for the index is 63 MB placed as an object literal and 57 MB placed via `JSON.parse`; the literal is preferred because escaping inflates the source. The shipped index must stay under 32 MB, which is half the budget.

Either way, this is how the model finds the right path instead of guessing it. The run tool's description stays small because everything else is one describe call away.

### graph_write

Arguments: `tenant`, `method` (POST, PATCH, PUT, or DELETE), `path`, optional `body`, optional `beta`, optional `dryRun`, and optional `confirmToken`.

The write flow has two steps.

1. The model calls the tool with `dryRun: true`. The server checks the connection's mode. If the connection is read, the result says so and names the connection. If it may write, the server builds a preview. For PATCH it fetches the current object and returns a field by field diff. For DELETE it fetches the object that would be removed and returns it. For POST and PUT it validates the body against the index and echoes it. The result includes a confirm token. The token is a keyed hash over tenant, method, path, and body, signed with a secret the server generates at startup, and it is valid for five minutes. Because the model never sees the secret, it cannot produce a token without a dry run.
2. The model calls the tool again with the same arguments and the confirm token. The server checks the token against the arguments, checks the mode again, and runs the write. The preview computed in step 1 is written to the audit log alongside the result.

A call without a token and without `dryRun` is rejected with a message that explains the two steps. This gives every client a confirmation step, even a client that never prompts on destructive tools.

### connections_list, connection_add, connection_remove

`connections_list` returns each connection's alias, tenant id, tenant name, account, kind, and scopes.

`connection_add` takes an optional `tenant` hint, an optional `alias`, a `template` of `read` or `read-write` defaulting to `read`, and an optional list of `scopes` that replaces the template's list. It opens the browser for a delegated sign-in, with device code as a fallback when no browser is available. The scopes are checked against the permissions index before the sign-in starts, and the request is written to the audit log. The person approves the scopes on Microsoft's consent screen. The tool never accepts a token, a secret, or a certificate password.

App-only connections are added with a companion command line, e.g., `npx ms-graph-mcp connect --app-only`, run by a person in a terminal. The command prompts for the secret or certificate password and stores it in the keychain. The model is never in that loop.

`connection_remove` takes an alias and removes the connection and its keychain entries.

### Task tools

Five task tools ship in version 1. Each one takes `tenant`, is a few lines over the Graph client, and returns typed structured output. They exist to prove that task tools are cheap once the client exists, and to give the model a clear finish line for the most common assessment questions.

- `ca_policies_missing_breakglass_exclusion`. Lists conditional access policies whose exclusions do not include the tenant's named break glass accounts. Takes the break glass user ids or principal names as an argument.
- `privileged_users_without_mfa`. Lists members of privileged directory roles who have no MFA method registered.
- `stale_devices`. Lists devices with no sign-in activity in the last N days.
- `guests_owning_groups`. Lists guest users who own one or more groups.
- `apps_with_high_privilege_permissions`. Lists service principals granted application permissions from a fixed list of high privilege permissions.

## Authentication

Delegated sign-in uses the Microsoft Authentication Library for Node with a public client. The default client id is the Microsoft Graph Command Line Tools application. A deployer can set their own client id and authority in config, which Microsoft recommends when they want tighter control over consent.

The scopes asked for on first sign-in are the chosen template's list, read by default. The read list is a set covering the task tools and common assessment queries, picked by hand once from a ranked shortlist because the 155 ceiling will not hold all 281 read scopes. Adding scopes later is a person's action through `connection_add`, and the consent screen is the gate.

What a token carries is not what was asked for. Every token after sign-in is acquired with `https://graph.microsoft.com/.default`, and Entra returns everything consented for the application in that tenant regardless. ADR-0003 chose Microsoft's shared Graph Command Line Tools app precisely because it is already consented in most tenants, which makes a wide token the normal case rather than the exception. Nothing here can be narrowed by asking for less, so the write tool checks the connection's mode instead.

App-only sign-in uses a client credential with a certificate or a secret from the keychain. The secret is stored through `@napi-rs/keyring`, called directly; the token cache for both kinds stays with the `@azure/msal-node-extensions` persistence plugin, which is what that package is for. See `docs/research/2026-09-16-keychain-library.md`.

No tool argument ever carries a credential. The token cache can be turned off with a config flag for people who do not want tokens persisted.

## Type delivery

The run tool's description contains the binding's type declarations shown above and three short worked examples. The budget for the description is under two thousand tokens, and a test enforces it. Everything specific to a resource comes from the describe tool. This keeps the fixed cost of the server small while still giving the model a way to look things up.

## Error handling

- A 403 from Graph names the missing permission from **three sources, in order, and always says which one answered**. First Graph's own error body, where it names a permission: it is always right and needs no join. Then the Graph index, which covers 62% of reads at one or two path segments and all 26 of the entry points an assessment uses. Otherwise, explicitly, "the index does not know", which is true and is more useful than silence. The result tells the model to ask the person to add the scope through `connection_add` whenever a name was found. The third branch is not a fallback to be tidied away later: 85% of what the permissions reference covers and the description does not is beta-only or unpublished, so it will never join, and a result that names no scope must say so rather than read as "this is not a permissions problem". Measured in `docs/research/2026-09-16-permissions-join.md`. **Not built yet: #25 settled the rule and corrected this paragraph, and #37 implements it. What ships today is the 404 near-miss hint, not a 403 mapping.**
- A 429 is retried inside the client using `Retry-After`, within the run's deadline. If the budget runs out the result says how long Graph asked to wait.
- A 404 is returned with a pointer to `graph_describe` and the closest matching paths from the index.
- A script error returns the failing line number, the message, and any output the script logged before it failed.
- Output over the cap is cut and flagged. The model is told to narrow the select, add a filter, or reduce the page count.

## Testing

- Unit tests for the Graph client run against recorded fixtures, so they need no tenant.
- Sandbox tests attempt to reach another hostname, the filesystem, environment variables, and `process`, and assert that each fails. They also assert that a runaway script is stopped at the deadline and that the next run still works, because the server recreates the runtime after a timeout.
- Table-driven tests cover scope classification: every name that must land in the read template, every name that must not, and each of the thirty-six unclassified names counting as a write.
- A test proves the write tool refuses a read-mode connection before any Graph request is built, using a token deliberately wider than the connection's scopes, which is the case Entra actually produces.
- A token budget test asserts the size of the tool list and the shaped size of a default users page.
- A live smoke test runs against a development tenant when an environment variable is set. It is skipped otherwise.

## Repository layout

```
src/
  core/
    connections/
    graph/        client, query builder, retry
    index/        loader and search over the shipped index
    sandbox/      Sandbox interface, the host worker source, and the binding
    audit/
    tools/        one file per tool, task tools under tools/tasks/
  transport/
    stdio/        stdio transport and the Miniflare sandbox driver
  cli/            the companion command line for app-only connections
scripts/
  build-index/    generates the Graph index from Microsoft metadata
data/
  graph-index.json
```

The Worker transport in version 2 is a new directory under `transport/`. The sandbox already uses the Worker Loader, so on Cloudflare the same host worker runs with the platform's loader binding instead of Miniflare's. Nothing under `core/` should need to change for it.

## Out of scope for version 1

- The Cloudflare Worker transport and MCP OAuth.
- MCP Apps user interfaces.
- Azure Resource Manager.
- Cross-tenant work inside one script. A run is bound to one tenant.
- Confirmation through MCP elicitation. The confirm token covers every client, and elicitation can be added later for clients that support it.
- Scheduled or unattended runs.

## Open items for the implementation plan

- ~~The permissions join resolves only 19% of v1.0 paths.~~ **Answered by #25.** The join is 31% after four mechanical fixes, and the headline was the wrong measure: coverage is 62% of reads at one or two path segments, 100% of the 26 entry points an assessment reads, and 0.7% six segments deep, which is most of Graph and none of the traffic. There is no other source to switch to. The CSDL's `Org.OData.Core.V1.Permissions` annotation is OData's property read/write marker, not a Graph scope, and nothing else in its 32 annotation terms carries one. 403-to-scope can ship on the three-source rule above; the remaining work is a live-tenant probe of how often Graph's own 403 body names a permission.
- The default `$select` has no upstream precedent. Microsoft publishes no such field and Cloudflare's server has no equivalent concept, because their API has no `$select`. The prototype derived it mechanically to size it; the real rule is still to be decided. Storing it per path costs about 0.6 MB.
- Only about 53% of paths resolve an entity type. The remainder are `$count`, `$ref`, action and container paths that legitimately have none, but nobody has confirmed the whole remainder is legitimate.
- Miniflare is pinned to an exact dated version, because its versions track `workerd` releases and the Worker Loader plugin is present from 4.20260730.0. Bumping it is a deliberate step.
- The hosted version needs Cloudflare's Dynamic Workers beta in production, which is a sign-up as of September 2026. Apply before starting version 2.
- ~~Pick the keychain library.~~ **Answered.** `@napi-rs/keyring` for the app-only secret. `keytar` is archived but already in the tree as a mandatory dependency of `@azure/msal-node-extensions`, so the choice was what our own code calls, not what is installed. See `docs/research/2026-09-16-keychain-library.md`.
- Decide the project name and the home directory name. `ms-graph-mcp` is the repository name and a placeholder.
- ~~Confirm the default scope list from the index once the index build script exists. It has to fit Entra's ceiling of about 155 delegated permissions, against 281 read scopes in the index, so this is a cut rather than a confirmation.~~ Settled in #49: `scripts/rank-read-scopes.ts` ranks read scopes by index path coverage, and the shipped list of 27 was chosen from its shortlist by hand. The ranking and why a purely mechanical cut was not taken are in `docs/measurements/2026-09-16-read-scope-ranking.md`.
