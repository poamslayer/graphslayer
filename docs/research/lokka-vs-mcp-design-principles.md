# Lokka measured against MCP and agent design principles

Research note, 2026-09-15. This compares Lokka, the open source Microsoft Graph MCP server at [github.com/merill/lokka](https://github.com/merill/lokka), against the Model Context Protocol specification, Microsoft Learn guidance for Microsoft Graph, and the agent design principles stored in `~/ai-best-practices/raw`. Two versions are in play and they are not the same artifact. The public source on the `main` branch is at commit [`b3790f7d3fdb8636703de82f88e74f9e822a099c`](https://github.com/merill/lokka/commit/b3790f7d3fdb8636703de82f88e74f9e822a099c), dated 2026-06-19, and that tree ships `src/mcp/package.json` version `0.3.0`. The package that `npx -y @merill/lokka` installs is version `2.1.2`, published 2026-06-19, whose source is not in the public repository. Every claim below says which of the two it comes from.

## Verdict up front

- The public source is a one-tool passthrough. `Lokka-Microsoft` takes `apiType`, `path`, `method`, `body` and four more parameters and forwards whatever the model writes to Microsoft Graph or Azure Resource Manager ([main.ts:144-158](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L144-L158)). The agent has to know Graph, not the server.
- The published v2.1.2 package is a different and much larger product than the public repository, with roughly 11 documented AI-callable tools, a multi-tenant connections manager, a permissions manager, and optional guardrails, all described only on [lokka.dev/docs/apps](https://lokka.dev/docs/apps). The `gitHead` recorded in the npm metadata for 2.1.2 is `1db65766a341e35cdc2b1db61a02ccfcc3966324`, which returns 404 in `merill/lokka`, and the MCP registry points at `https://github.com/jozrahq/lokka`, which is also not public. You cannot audit the code you install.
- Neither version sets MCP tool annotations. In the published spec, an unset `destructiveHint` defaults to `true` and an unset `readOnlyHint` defaults to `false`, so a client that reads annotations gets nothing more specific than "this might destroy something", for both reads and deletes ([MCP schema reference](https://modelcontextprotocol.io/specification/2026-07-28/schema)).
- In the public source there is no read-only mode, no confirmation step, no allow list, no deny list, and no per-tenant scoping. A `DELETE /users/{id}` call is exactly as easy for the model to emit as a `GET /users`. The v2 Guardrails feature exists, is marked Experimental, and is off by default ([lokka.dev/docs/apps](https://lokka.dev/docs/apps)).
- The default Graph API version in the public source is `beta`, not `v1.0` ([constants.ts:8-10](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/constants.ts#L8-L10)). Microsoft states plainly that "Use of beta APIs in production applications is not supported" ([versioning and support](https://learn.microsoft.com/graph/versioning-and-support#support-policy-and-deprecation-information)).
- Context cost on responses is the real problem, not the tool definitions. The four public tool definitions cost roughly 860 tokens. A single default `GET /users` page, which Microsoft documents as 100 objects, costs roughly 10,600 tokens the way Lokka formats it. `fetchAll: true` against a 5,000 user tenant produces roughly 520,000 tokens of text in one tool result.
- `set-access-token` accepts a raw Microsoft Graph bearer token as a tool argument ([main.ts:409-415](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L409-L415)), and the documented workflow is to paste one from Graph Explorer or `az account get-access-token` ([token auth](https://lokka.dev/docs/install-advanced/token-auth)). That puts a live credential through the model's context. The MCP specification forbids form mode elicitation for exactly this class of data and requires URL mode instead ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).
- `add-graph-permission` lets the model ask for any Graph scopes it wants and triggers a fresh interactive sign-in to get them ([main.ts:492-497](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L492-L497)). Scope escalation is a model-initiated action with a human approval step that lives in the browser consent screen, not in the agent loop.
- The project's own FAQ says "Lokka is not a production-ready solution and should not be used in a production environment" ([FAQ](https://lokka.dev/docs/faq)). Any comparison should take that at face value. The gap a purpose-built server fills is the production gap, not a feature gap.
- The strongest defensible differentiation is task-shaped read tools with server-side `$select` and result shaping, a real read-only default, per-tenant connection isolation with no credentials in model context, and structured output with schemas. None of those require beating Lokka on Graph coverage.

## 1. Tool surface

### What the public source exposes

The `main` branch at `b3790f7` registers four tools, all in `src/mcp/src/main.ts`:

| Tool | Registered at | Purpose |
|---|---|---|
| `Lokka-Microsoft` | [main.ts:144](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L144) | Any Graph or Azure Resource Manager request |
| `set-access-token` | [main.ts:409](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L409) | Supply or replace a bearer token |
| `get-auth-status` | [main.ts:457](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L457) | Report auth mode and token scopes |
| `add-graph-permission` | [main.ts:492](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L492) | Request more delegated scopes by re-signing in |

The `Lokka-Microsoft` input schema, quoted from [main.ts:147-158](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L147-L158), has ten parameters: `apiType` (enum `graph` or `azure`), `path` (free string), `method` (enum `get`, `post`, `put`, `patch`, `delete`), `apiVersion`, `subscriptionId`, `queryParams` (record of string), `body` (arbitrary record), `graphApiVersion` (enum `v1.0` or `beta`, defaulting to `beta`), `fetchAll` (boolean, default `false`), and `consistencyLevel` (free string). Only `apiType`, `path` and `method` are required.

The tool description carries one piece of Graph-specific coaching: "For Graph API GET requests using advanced query parameters ($filter, $count, $search, $orderby), you are ADVISED to set 'consistencyLevel: \"eventual\"'" ([main.ts:146](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L146)). That advice is correct and matches Microsoft's documented requirement for advanced queries on directory objects, but it is delivered as prose in a tool description rather than enforced in code. The server never sets `ConsistencyLevel` on the model's behalf, it only passes through whatever string the model supplies ([main.ts:206-210](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L206-L210)).

### What the published v2.1.2 exposes

The docs site lists these as "Tools the AI can call directly": `Lokka-Microsoft`, `open-graph-explorer`, `open-lokka-connections`, `open-lokka-settings`, `open-lokka-permissions`, `open-lokka-help`, `lokka-list-connections`, `switch-lokka-connection`, `get-auth-status`, `set-access-token`, `add-graph-permission`. That is eleven. The same page adds that "A further set of internal tools (prefixed `lokka-`) powers the app UIs and is hidden from the AI in MCP Apps hosts" ([lokka.dev/docs/apps](https://lokka.dev/docs/apps)). The count of hidden tools is not published.

Six of those eleven are UI launchers or connection management. The actual Graph surface is still the single `Lokka-Microsoft` passthrough. v2 moved the shaping work into a human-facing Graph explorer with endpoint autocomplete over "28,000+ Graph endpoints" and OData IntelliSense, which is a real improvement for the person, but the model's action space is unchanged.

### What generic passthrough costs in accuracy

Two things in the principle set bear directly on this.

Thariq's account of building Claude Code's action space is the sharpest. "The bar to add a new tool is high, because this gives the model one more option to think about", and the design goal is to "give it tools that are shaped to its own abilities" (`~/ai-best-practices/raw/lessons-building-claude-code-seeing-like-an-agent.md`). Lokka went to the other extreme: one tool shaped to the API's abilities, with the entire Microsoft Graph surface hidden behind a free-text `path` string. The model must supply the endpoint, the OData parameters, the API version, the consistency level, and the request body from memory. Every one of those is a place to be wrong, and nothing in the schema constrains any of them. A wrong `path` returns a 404 that the model has to interpret. A wrong `$filter` returns a 400. A missing `ConsistencyLevel` returns a specific Graph error the model then has to map back to the advice buried in the tool description.

Thariq's later post argues the opposite direction is now viable: "MCPs are better than CLIs for most integrations... If you need to compose/filter data, add params like query to your MCP tools" (`~/ai-best-practices/raw/trq212-mcp-better-than-clis.md`). Lokka does have a filter parameter in the sense that `queryParams` accepts `$filter`, but it is an untyped `Record<string, string>` with the description "Query parameters for the request". There is no per-resource knowledge in the schema, so the parameter carries no information the model did not already have.

Rhys Sullivan's list of MCP advantages includes an "indexable tool catalog letting agents scale to unlimited tools" (`~/ai-best-practices/raw/rhyssullivan-mcp-beats-clis.md`). Lokka's catalog is not indexable in any useful sense, because there is only one entry for the entire API. Tool Search, which Claude Code triggers when MCP tool descriptions would use more than 10% of context (`~/ai-best-practices/raw/tool-search-in-claude-code.md`), has nothing to search. A server with fifty task-shaped tools benefits from deferred loading. A server with one god-tool cannot.

The Cloudflare code mode post makes the case that "If you present an LLM with too many tools, or overly complex tools, it may struggle to choose the right one or to use it correctly. As a result, MCP server designers are encouraged to present greatly simplified APIs as compared to the more traditional API they might expose to developers" (`~/ai-best-practices/raw/cloudflare-code-mode.md`). Lokka's tool is not numerous but it is complex, and it is the raw developer API rather than a simplified one.

An honest counterpoint: the passthrough design is why Lokka works on day one against every Graph endpoint including beta, and why a purpose-built server with fifty curated tools will always have coverage gaps. The right answer is probably both, with the curated tools carrying the common paths and a clearly labelled escape hatch for everything else.

## 2. Auth and multi-tenant

### Modes in the public source

`AuthMode` is an enum with four values: `ClientCredentials`, `ClientProvidedToken`, `Interactive`, `Certificate` ([auth.ts:102-107](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/auth.ts#L102-L107)). Mode selection happens once at process start from environment variables, and enabling more than one throws ([main.ts:683-723](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L683-L723)):

| Env var | Effect |
|---|---|
| `USE_CLIENT_TOKEN=true` | Client-provided bearer token mode |
| `USE_INTERACTIVE=true` | Interactive browser sign-in, device code fallback |
| `USE_CERTIFICATE=true` | Client certificate, needs `CERTIFICATE_PATH`, optional `CERTIFICATE_PASSWORD` |
| `TENANT_ID` + `CLIENT_ID` + `CLIENT_SECRET` with none of the above | Client credentials |
| none of the above | Interactive, with a logged note that it defaulted there |

Credentials come from `@azure/identity`: `ClientSecretCredential`, `ClientCertificateCredential`, `InteractiveBrowserCredential` with a `DeviceCodeCredential` fallback ([auth.ts:129-194](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/auth.ts#L129-L194)). Client secret and certificate password arrive as plain environment variables in the MCP client's JSON config, which the install docs show verbatim ([app-only auth](https://lokka.dev/docs/install-advanced/app-only-auth)).

### Token acquisition and scopes

For Graph, the auth provider always requests `https://graph.microsoft.com/.default` ([auth.ts:49-55](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/auth.ts#L49-L55)). That means the token carries whatever was already consented for the app, not a per-task least-privilege scope set. For Azure Resource Manager it requests `https://management.azure.com/.default` and re-acquires a token on every page during `fetchAll` ([main.ts:280-285](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L280-L285), [main.ts:313-318](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L313-L318)).

Scopes are surfaced to the model by decoding the JWT without verifying its signature and reading `scp` or `roles` ([auth.ts:11-39](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/auth.ts#L11-L39)). Not verifying the signature is defensible here because the token came from Azure Identity, and the code says so, but it means the scope list is informational only.

### The default app registration

With no configuration at all, interactive mode uses hardcoded values: `LokkaClientId = "a9bac4c3-af0d-4292-9453-9da89e390140"`, `LokkaDefaultTenantId = "common"`, `LokkaDefaultRedirectUri = "http://localhost:3000"` ([constants.ts:3-5](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/constants.ts#L3-L5)). Using the `common` endpoint is how a multitenant app signs users in to their home tenant, per Microsoft's guidance that a multitenant app "can use the organizations endpoint or the common endpoint to sign in users in the user's home tenant" ([identity and account types](https://learn.microsoft.com/security/zero-trust/develop/identity-supported-account-types#accounts-in-any-organizational-directory-only---multitenant)). So the default install consents a third-party-owned multitenant app registration into the customer's tenant. That is a governance decision the operator is making without being asked to make it. The docs do offer a custom app path ([interactive auth](https://lokka.dev/docs/install-advanced/interactive-auth)), but the quick start does not use it.

The v2 docs say user sign-in now defaults to "the Microsoft Graph PowerShell public client (`14d82eec-…`, already present in most tenants)" with the Lokka app or a custom public client available under Advanced ([lokka.dev/docs/apps](https://lokka.dev/docs/apps)). Defaulting to an app already present in the tenant is better for consent hygiene. It is also a broad, widely consented app, so scope creep on that service principal affects more than Lokka.

### Can one instance serve multiple tenants?

In the public source, no. `authManager` and `graphClient` are module-level singletons set once in `main()` ([main.ts:23-24](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L23-L24), [main.ts:769-779](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L769-L779)). `TENANT_ID` is read from the environment at startup. The only way to change tenant at runtime is `set-access-token` with a token for another tenant, or `add-graph-permission`, which nulls out both singletons and rebuilds them from a fresh interactive sign-in ([main.ts:573-647](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L573-L647)). Neither is tenant isolation. There is no per-request tenant binding, no way to hold two tenants at once, and nothing stamps a result with the tenant it came from. For an MSP running one agent across many customer tenants, the public source means one server process per tenant.

The published v2.1.2 fixes this. The connections manager holds multiple signed-in connections "grouped by tenant", exposes `lokka-list-connections` and `switch-lokka-connection`, and the docs state that "All Graph and Azure calls route through the active connection" and that "every result is also stamped with the connection it ran against" ([lokka.dev/docs/apps](https://lokka.dev/docs/apps)). It also stores service principal secrets and certificate passwords encrypted in the OS keychain, caches user tokens in the OS credential store, and offers `LOKKA_DISABLE_TOKEN_CACHE=true` to turn persistence off. This is a genuinely better model than environment-variable secrets. It is still one active connection at a time rather than a tenant parameter per call, so a single agent turn cannot fan out across tenants, and the switch is a stateful side effect the model performs.

### Where this collides with the MCP specification

Two collisions matter.

First, `set-access-token` moves a live Microsoft Graph bearer token through the MCP client as a tool argument, which means it is generated by the model into the conversation. The specification's elicitation rules are explicit that servers "MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials" and "MUST use URL mode for interactions involving such sensitive information", with the rationale that "sensitive credentials never pass through the LLM context, MCP client or any intermediate MCP servers" ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). A tool parameter is worse than form elicitation, not better, because it is the model that writes the value. Lokka's own docs call token auth "useful for development and testing purposes, but it is not recommended for production use due to security concerns" ([token auth](https://lokka.dev/docs/install-advanced/token-auth)), which is fair warning but does not change the shape of the tool.

Second, the specification's authorization framework covers the client-to-server leg and expects servers to be OAuth resource servers with third-party credentials obtained out of band. Lokka is stdio-only in the public source (`StdioServerTransport`, [main.ts:786](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L786)), so MCP authorization does not apply and the whole question reduces to local process credentials. That is a reasonable choice for a desktop tool and a dead end for a hosted multi-tenant one.

## 3. Guardrails

### Public source

There are none for Graph. Concretely, reading [main.ts:212-264](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L212-L264):

- Every HTTP method in the enum is dispatched with no distinction. `delete` reaches `request.delete()` with no check on what is being deleted.
- No allow list or deny list on `path`. For Graph, the path goes straight into `graphClient.api(path)`.
- No resource scoping. Nothing restricts which group, user, or policy can be touched.
- No confirmation, no dry run, no diff preview, no elicitation.
- No read-only environment variable. `USE_GRAPH_BETA=false` pins the API version, not the verb set.
- No rate limiting, no 429 handling of its own. The Graph SDK's middleware handles retries for Graph, and the hand-rolled Azure Resource Manager fetch loop has no retry or `Retry-After` handling at all ([main.ts:304-346](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L304-L346)). Microsoft's guidance is to "Wait the number of seconds specified in the `Retry-After` header" and retry ([throttling guidance](https://learn.microsoft.com/graph/throttling#best-practices-to-handle-throttling)).
- No tool annotations. The `server.tool(name, description, schema, handler)` calls never pass an annotations object, so `readOnlyHint` and `destructiveHint` are absent. Per the schema reference, `readOnlyHint` defaults to `false` and `destructiveHint` defaults to `true` ([MCP schema reference](https://modelcontextprotocol.io/specification/2026-07-28/schema)). A client cannot tell a directory read from a directory delete.
- Audit is a local append-only file. `logger` writes to `mcp-server.log` next to the built code ([logger.ts:4-7](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/logger.ts#L4-L7)), and the tool logs `apiType`, `path`, `method`, `graphApiVersion`, `fetchAll` and `consistencyLevel` ([main.ts:185](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L185)). Request bodies are not logged, so the log records that a PATCH happened but not what it wrote. There is no log rotation and no export.

There is one real guardrail, and it is for Azure Resource Manager only. `validateAzurePath` rejects `@`, double slashes, absolute URLs and backslashes, and `buildAzureUrl` composes the URL with the `URL` constructor and `searchParams` so the host is pinned to `management.azure.com` ([main.ts:51-142](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L51-L142)). This came from the merge commit at the head of `main`, titled "Security: Fix SSRF/token exfiltration vulnerability using URL standard". The equivalent check does not exist for the Graph path, which is delegated to the Graph SDK.

Blast radius is therefore set entirely by the consented permissions. Microsoft's own framing is the relevant warning: "Application permissions are highly privileged because they allow applications to access and modify resources without requiring a signed-in user", and an app with `User.ReadWrite.All` "can update many of the writable user properties supported by Microsoft Graph, including for users assigned privileged admin roles" ([permissions overview](https://learn.microsoft.com/graph/permissions-overview#permission-types)). Lokka's own docs note this correctly, saying "The agent will only be able to perform the actions based on the permissions you grant it" ([intro](https://lokka.dev/docs/intro)). That is true and it is also the whole defence. Once an admin has granted `Directory.ReadWrite.All` so that the agent can do one useful write, every other write in the directory is in scope for every future turn.

`add-graph-permission` makes this worse in one specific way. The model chooses the scopes. It validates only that each scope contains a dot and has no surrounding whitespace ([main.ts:549-559](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L549-L559)), then triggers an interactive sign-in for them. The human approval happens in the Entra consent screen, which is a real control, but it is a screen the user is being pushed toward by the model mid-task, which is the condition under which people click accept.

### Published v2.1.2

v2 adds Guardrails, and the design is sound on paper. From [lokka.dev/docs/apps](https://lokka.dev/docs/apps): rules are checked "server-side on model-originated Lokka calls before any request leaves your machine"; "The AI can read the guardrails but can never change them"; enforcement covers HTTP methods, an API allow list or deny list with path patterns such as `/users` and `/groups/*`, and resource scoping to specific ids where "An allowed group id permits `/groups/{id}` and child paths such as `/groups/{id}/members`"; Global and per-tenant rules combine most-restrictive-wins; blocked calls return the specific rule that stopped them; rules live in `~/.lokka/guardrails.json`.

Three caveats, all from the same page. Guardrails are "off by default, so Lokka runs what the model asks unless you turn enforcement on". The feature is labelled "(Experimental)". And the read-only default only applies once you opt in: "When guardrails are enabled, the default policy is GET only". A safety feature that is off by default protects the population that already knew to turn it on.

Against the MCP specification's own security guidance for servers, which says servers "MUST" validate all tool inputs, implement proper access controls, rate limit tool invocations and sanitize tool outputs ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)), the public source meets input validation only for the Azure path and meets none of the other three.

## 4. Context cost

### Method

All token figures below are character counts divided by four. That is a rough heuristic, not a tokenizer run, and it tends to underestimate for JSON with lots of punctuation and GUIDs. The script that produced them reconstructed the `tools/list` payload from the Zod schemas in `main.ts` as the MCP TypeScript SDK would serialize them, and built response bodies from the example `GET /users` response in Microsoft's own documentation.

### Tool definitions

| Tool | JSON chars | Approx tokens |
|---|---|---|
| `Lokka-Microsoft` | 1,879 | 470 |
| `set-access-token` | 589 | 147 |
| `get-auth-status` | 336 | 84 |
| `add-graph-permission` | 609 | 152 |
| Full `tools/list` payload | 3,428 | 857 |

Under 1,000 tokens for the whole server is cheap, and well under the 10% of context that triggers Claude Code's Tool Search (`~/ai-best-practices/raw/tool-search-in-claude-code.md`). On this axis Lokka is fine, and a purpose-built server with thirty or forty task-shaped tools would cost more. That trade is worth making only if the extra definition tokens buy back more than they cost in response tokens and retries.

The v2.1.2 definition cost cannot be measured, because the source is not public and the count of hidden internal tools is not published.

### Response cost

This is where the budget goes. Microsoft documents that "the `GET /users` endpoint returns a default of 100 results in a single page" ([paging](https://learn.microsoft.com/graph/paging)), and that by default the response carries eleven properties per user: `businessPhones`, `displayName`, `givenName`, `id`, `jobTitle`, `mail`, `mobilePhone`, `officeLocation`, `preferredLanguage`, `surname`, `userPrincipalName` ([list users](https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0)).

Lokka returns that as a text block. It prefixes a line, then `JSON.stringify(responseData, null, 2)`, then possibly a pagination note ([main.ts:367-376](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L367-L376)). Measured against Microsoft's sample user object:

| Payload | Chars | Approx tokens |
|---|---|---|
| One user object, indent 2 | 357 | 89 |
| Default 100-user page, as Lokka formats it | 42,236 | 10,559 |
| Same payload, compact JSON | 30,667 | 7,667 |
| Same 100 users with `$select=displayName,userPrincipalName,id` | 15,419 | 3,855 |
| `fetchAll: true` over a 5,000 user tenant | 2,095,044 | 523,761 |

Three findings from that table.

Pretty printing costs about 38% more than compact JSON for the same data, for no benefit to the model. That is roughly 2,900 wasted tokens on a single `GET /users`.

Not defaulting `$select` costs about 63% of the response. Microsoft's guidance for handling throttling is to "try reducing the amount of data returned" ([throttling limits](https://learn.microsoft.com/graph/throttling-limits#identity-and-access-reports-service-limits)), and `$select` is the documented mechanism ([query parameters](https://learn.microsoft.com/graph/query-parameters#top)). Lokka exposes `$select` through the untyped `queryParams` record but never sets one, so whether it gets used depends on whether the model thinks to.

`fetchAll` is a context bomb with no ceiling. There is no cap on page count, no cap on total items, no truncation, and no summarisation. The code accumulates every item into `allItems` and serializes the lot ([main.ts:215-239](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L215-L239)). At roughly 520,000 tokens for 5,000 users, one tool call exceeds a 200K context window by more than double and eats half of a 1M window. The parameter is documented to the model as "Set to true to automatically fetch all pages for list results (e.g., users, groups)" with no warning about size, and the single-page path actively nudges the model toward it: "Note: More results are available. To retrieve all pages, add the parameter 'fetchAll: true' to your request" ([main.ts:374](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L374)).

Two smaller costs. The `@odata.nextLink` skip token is echoed into context verbatim and is useless to the model, since the model cannot pass it back. And error results serialize the entire Graph error body ([main.ts:390-401](https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts#L390-L401)).

Nothing is returned as `structuredContent`, and no tool declares an `outputSchema`. The specification says an output schema helps by "Enabling strict schema validation of responses" and "Guiding clients and LLMs to properly parse and utilize the returned data" ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). Lokka predates or ignores that.

Put against the principle set, this is the clearest failure. Vas's argument is that "A good harness prevents the model from being inundated with information that it doesn't need... Narrow context is also more accurate, since irrelevant information is exactly where models get confused" (`~/ai-best-practices/raw/vasuman-spend-less-tokens.md`). A 10,559 token answer to "how many users do we have" is the opposite of a good harness. Machina's complaint about MCP servers is aimed exactly here: "a command gives back only the lines you ask for, an MCP dumps its entire result into the window every single time" (`~/ai-best-practices/raw/exm7777-notable-posts.md`, 2026-08-11). Lokka is the MCP server that quote is describing, and it does not have to be, because nothing in MCP forces a server to dump. Rhys makes that point directly: "you can do some combination of lazy loading, searchable tools, and filtering to build efficient harnesses" (`~/ai-best-practices/raw/rhyssullivan-mcp-beats-clis.md`).

One thing v2 does fix on the human side. The Graph explorer keeps results out of the model by default: "Results stay private to the explorer until you click `Add to context` or `Ask`, you decide what the AI sees" ([lokka.dev/docs/apps](https://lokka.dev/docs/apps)). That is a good pattern and it applies only to the human-driven path, not to model-originated calls.

## 5. Where a purpose-built Microsoft Graph MCP could beat it

Each item below is tied to a measured gap above, not to a feature wish list.

**Server-side result shaping, with a hard ceiling.** Default `$select` per resource type, cap the number of items returned in one tool result, and return a cursor handle instead of a raw `@odata.nextLink`. On the measured numbers this turns a 10,559 token `GET /users` into something under 4,000 tokens before any capping, and it removes the 520,000 token failure mode entirely. The specification's stateful tools section describes the handle pattern and its obligations, including that the server "should validate the caller's authorization against the handle on every call" ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). Emit compact JSON, not indent 2, and put the real payload in `structuredContent` against a declared `outputSchema`.

**Task-shaped read tools for the paths that matter, with an explicit escape hatch.** Lokka's own marketing queries name the targets: conditional access policies that do not exclude break-glass accounts, Intune device configuration policies assigned to a group, dynamic security groups ([intro](https://lokka.dev/docs/intro)). Each of those is a multi-call Graph pattern the model currently has to reconstruct. A tool named for the task, that knows which endpoint, which `$select`, which `$expand`, and which `ConsistencyLevel` to set, converts several model round trips and several thousand tokens of wrong-shaped intermediate results into one call. This is the "seeing like an agent" point applied: shape the tool to the model's abilities rather than to the API's surface. Keep the raw passthrough as one clearly marked tool so coverage never regresses, and set `readOnlyHint: true` on every read tool so clients can distinguish them.

**Read-only by default, and a write path that is a separate tool.** Lokka's Guardrails already prove the design and then default it off. Invert that. Ship with writes disabled, require an explicit opt-in per verb and per path, and put writes behind distinct tools with `destructiveHint` set honestly rather than behind a `method` enum value. The MCP specification tells clients to "Prompt for user confirmation on sensitive operations" ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)), and the server can make that easy or impossible. A generic `Lokka-Microsoft` call makes it impossible, because the client cannot tell from the tool name what is about to happen. `delete_group` makes it trivial.

**Real multi-tenant isolation.** v2.1.2 has a connections manager with one active connection and a stateful `switch-lokka-connection` tool. A tenant identifier as a required parameter on every call is stronger: it is auditable per call, it cannot drift between the moment the model switched and the moment it acted, and it lets one agent turn touch two tenants deliberately rather than by accident. Microsoft's multitenant guidance puts the burden on the developer directly: "As a developer, it's your responsibility to keep tenant information separate" ([identity and account types](https://learn.microsoft.com/security/zero-trust/develop/identity-supported-account-types#multitenant-app-considerations)). For an MSP running assessments across many customer tenants, this is the difference between one server and one server per customer.

**No credentials in model context, ever.** Drop the `set-access-token` shape. If the server needs a credential it should use URL mode elicitation, which the specification describes precisely for this case and which guarantees the credential does not transit the client or the model ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). Store secrets in the OS keychain the way v2 already does for connections, not in MCP client JSON as `CLIENT_SECRET`.

**Default to `v1.0`.** Lokka defaults to `beta`. Microsoft's position is unambiguous: "Use of beta APIs in production applications is not supported" and "we strongly recommend that developers use the v1.0 endpoint when they build production apps" ([versioning](https://learn.microsoft.com/graph/versioning-and-support#support-policy-and-deprecation-information), [beta in production](https://learn.microsoft.com/microsoft-cloud/dev/dev-proxy/concepts/use-microsoft-graph-beta-production)). Default to `v1.0`, allow `beta` per call, and say in the result which one ran.

**Structured audit that is not a text file next to the binary.** Log tenant, principal, tool, method, path, query, a hash or redaction of the body, status, and duration, as newline-delimited JSON to a configurable path. For anyone doing compliance work this is the artifact that makes agent use defensible after the fact, and it costs almost nothing to build.

**Throttling as a first-class behaviour.** Honour `Retry-After` on 429 for both Graph and Azure Resource Manager, surface the wait to the model as a tool execution error it can act on, and prefer `$filter` and `$count` over client-side `fetchAll` where the API supports it. Microsoft's guidance is explicit that backing off on `Retry-After` "is the fastest way to recover from throttling" ([throttling](https://learn.microsoft.com/graph/throttling#best-practices-to-handle-throttling)).

**Deterministic where determinism is available.** Vas's framing is that "the number of steps in a workflow and the amount of intelligence required in that workflow are two very different things" and that production systems that work are "85% code and 15% LLM" (`~/ai-best-practices/raw/vasuman-spend-less-tokens.md`, `~/ai-best-practices/raw/vasuman-if-ai-is-so-great-why-isnt-it-working.md`). Setting `ConsistencyLevel: eventual` when the query uses `$filter` with `endsWith`, choosing `$select` for a known resource type, mapping a 403 to the exact missing permission: none of those need a model. Lokka asks the model to do all three. A purpose-built server does them in code and spends model tokens only on the judgment call, which is what to query and what it means.

## Principles scorecard

| Principle (source) | How Lokka measures | Implication for a new server |
|---|---|---|
| Shape tools to the model's abilities; the bar to add a tool is high because each one is another option to weigh (`lessons-building-claude-code-seeing-like-an-agent.md`) | One god-tool shaped to the API, not the agent. Free-text `path`, untyped `queryParams`, no per-resource knowledge | Curate task-shaped tools for the top paths, keep one labelled passthrough for coverage |
| Progressive disclosure: let the agent discover context incrementally rather than preloading it (`lessons-building-claude-code-seeing-like-an-agent.md`) | None. The model must already know Graph. No resource catalog, no schema lookup tool, no samples exposed to the model | Ship an endpoint or permission lookup tool so the model can find the right path instead of guessing it |
| Composition and filtering belong in tool parameters (`trq212-mcp-better-than-clis.md`) | `queryParams` is an untyped string record. No typed filter, no field selection, no summarise mode | Typed `select`, `filter`, `top`, and a `mode` that returns counts or summaries instead of rows |
| Indexable tool catalog, deferred loading (`rhyssullivan-mcp-beats-clis.md`, `tool-search-in-claude-code.md`) | Nothing to index. Four tools, ~857 tokens, so Tool Search never triggers and buys nothing | More tools is affordable. Budget the definition tokens and win them back on responses |
| Consistent auth across MCPs; multi-account support (`rhyssullivan-mcp-beats-clis.md`) | Four modes, all chosen at process start from env vars. Public source is single tenant per process. v2 adds a connections manager with one active connection | Tenant as a per-call parameter, credentials in the keychain, never in model context |
| Simplify the API you expose; LLMs struggle with complex tools (`cloudflare-code-mode.md`) | The raw developer API is exposed verbatim, which is exactly what the post says not to do | Simplify per task. Consider a code-mode surface only after the task tools exist |
| Narrow context is more accurate; a good harness stops the model being inundated (`vasuman-spend-less-tokens.md`) | 10,559 tokens for one default `GET /users`; 523,761 for `fetchAll` over 5,000 users; pretty printed; no `$select` | Compact JSON, default `$select`, hard item caps, cursor handles, `structuredContent` with `outputSchema` |
| Use the LLM only where judgment lives; code everything else (`vasuman-spend-less-tokens.md`, `vasuman-if-ai-is-so-great-why-isnt-it-working.md`) | Endpoint choice, OData syntax, consistency level and permission diagnosis are all pushed to the model | Do all four in code. Reserve model tokens for what to ask and what the answer means |
| One orchestration layer with shared approvals and audit logging (`vasuman-five-principles-ai-that-ships.md`) | Approvals: none in the public source, off by default in v2. Audit: a local unrotated text file with no request bodies | Structured NDJSON audit with tenant and principal; approval gate in front of every write |
| Continuous infrastructure, not a side project (`vasuman-five-principles-ai-that-ships.md`) | Self-described proof of concept. Public repo at v0.3.0 while npm ships 2.1.2 from a source that is not public | Version the public source and the package together, or nobody can review what they run |
| Agent sprawl is architectural debt; one platform, not many bespoke agents (`vasuman-if-ai-is-so-great-why-isnt-it-working.md`) | Lokka is the sprawl-friendly option: an admin installs it per machine with its own app registration and its own secrets | Central policy file, shared connection store, one audit stream across every agent using the server |
| Five-part agent test: repeated trigger, stable inputs, clear tools, measurable finish line, judgment in the middle (`gregisenberg-five-part-agent-test.md`) | Fails "clear tools" and "measurable finish line". One tool that can do anything means the agent cannot tell when it is done | Task tools give a finish line. `list_conditional_access_gaps` either returns gaps or it does not |
| MCP servers dump their whole result into the window (`exm7777-notable-posts.md`, 2026-08-11) | Accurate description of Lokka's response handling | This is the single biggest win available. Nothing in MCP forces a server to dump |
| MCP spec: human in the loop, confirmation prompts on sensitive operations (`modelcontextprotocol.io` tools) | No annotations, so the client cannot distinguish read from delete. No confirmation path | Set `readOnlyHint` and `destructiveHint` honestly; separate write tools by name |
| MCP spec: servers MUST validate inputs, enforce access control, rate limit, sanitize output (`modelcontextprotocol.io` tools) | Input validation for the Azure path only. No access control in public source. No rate limiting. No output sanitisation | Path allow list, method policy, resource scoping, `Retry-After` handling, output size limits |
| MCP spec: never request credentials in band; use URL mode elicitation (`modelcontextprotocol.io` elicitation) | `set-access-token` takes a bearer token as a tool argument; the docs tell users to paste one in | URL mode elicitation or OS keychain. No credential ever becomes a tool argument |
| Microsoft Learn: use `v1.0` in production, `beta` is unsupported | Defaults to `beta` unless `USE_GRAPH_BETA=false` | Default `v1.0`, opt into `beta` per call, state which ran |
| Microsoft Learn: least privilege, delegated over application permissions | Requests `.default`, so the token carries everything already consented. `add-graph-permission` lets the model pick new scopes | Per-task scope sets, a permission preflight that names the least-privileged scope, no model-initiated escalation without an in-loop gate |

## Open questions and unverified

- **The v2.1.2 source is not public.** The npm metadata for 2.1.2 records `gitHead` `1db65766a341e35cdc2b1db61a02ccfcc3966324`, which returns 404 against `merill/lokka`. The package declares `mcpName: "io.github.jozrahq/lokka"` and the MCP registry entry points at `https://github.com/jozrahq/lokka`, which returns "Not Found". Everything in this note about v2 comes from lokka.dev and the npm and MCP registry metadata, not from reading code. Tool schemas, guardrail enforcement logic, token storage details and response formatting in v2 are all unverified.
- **v2 tool count and definition token cost.** Eleven AI-callable tools are documented. The number and shape of the hidden `lokka-` internal tools is not published, so the total `tools/list` cost for v2 cannot be estimated.
- **Whether v2 sets tool annotations, output schemas, or `structuredContent`.** Not stated anywhere I could find, and not verifiable without the source.
- **Whether v2 still pretty prints responses or defaults `$select`.** Not stated. The response cost table above applies to the public v0.3.0 source only.
- **The default app registration's `signInAudience`.** `LokkaDefaultTenantId = "common"` strongly implies the app `a9bac4c3-af0d-4292-9453-9da89e390140` is registered as multitenant, but I did not query the Entra application object to confirm it, and I did not verify who owns it beyond the repository author.
- **The v2 default sign-in app id.** The docs truncate it as `14d82eec-…` and describe it as "the Microsoft Graph PowerShell public client". That app id is widely associated with Microsoft Graph PowerShell, but I did not find a Microsoft Learn page that states the GUID, so treat the identification as unverified.
- **MCP Apps.** Lokka v2 says it renders interactive apps "In hosts that support MCP Apps". MCP Apps is referenced in the Model Context Protocol documentation, in the Inspector recipes page, but there is no MCP Apps page in the `2026-07-28` specification index. Whether it is normative, an extension, or a client-specific capability is unresolved here.
- **Token estimates.** All figures are characters divided by four, not tokenizer output. Treat them as accurate to within roughly 20%, and as relative comparisons rather than exact budgets.
- **Reconstructed tool schemas.** The `tools/list` payload used for the definition token count was reconstructed from the Zod schemas in `main.ts` as the MCP TypeScript SDK would serialize them. I did not run the server to capture the real payload, per the read-only constraint on this research.
- **Doc drift in the public repository.** The root `README.md` documents `REDIRECT_URI` default as `http://localhost:3000` while `src/mcp/README.md` says `http://localhost:3200`; `constants.ts` says `3000`. The `McpServer` constructor declares version `0.2.0` while `package.json` says `0.3.0`. The `interactive-auth` docs page still says sign-in is required on every client start, while the v2 install page says sign-ins are remembered. These are inconsistencies in the sources, not findings about behaviour.

## Sources

### Lokka, public source at commit `b3790f7d3fdb8636703de82f88e74f9e822a099c` (2026-06-19)

- https://github.com/merill/lokka
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/main.ts
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/auth.ts
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/constants.ts
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/src/logger.ts
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/package.json
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/README.md
- https://github.com/merill/lokka/blob/b3790f7d3fdb8636703de82f88e74f9e822a099c/src/mcp/TESTING.md

### Lokka, published package and docs site

- https://registry.npmjs.org/@merill/lokka (version list, publish timestamps, `gitHead`, `mcpName`)
- https://registry.modelcontextprotocol.io/v0/servers?search=lokka
- https://lokka.dev/docs/intro
- https://lokka.dev/docs/install
- https://lokka.dev/docs/apps
- https://lokka.dev/docs/install-advanced/interactive-auth
- https://lokka.dev/docs/install-advanced/app-only-auth
- https://lokka.dev/docs/install-advanced/token-auth
- https://lokka.dev/docs/faq

### Model Context Protocol specification

- https://modelcontextprotocol.io/specification/versioning (current revision `2026-07-28`)
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- https://modelcontextprotocol.io/specification/2026-07-28/schema (`ToolAnnotations` defaults)
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools

### Microsoft Learn

- https://learn.microsoft.com/graph/paging
- https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0
- https://learn.microsoft.com/graph/query-parameters
- https://learn.microsoft.com/graph/versioning-and-support
- https://learn.microsoft.com/microsoft-cloud/dev/dev-proxy/concepts/use-microsoft-graph-beta-production
- https://learn.microsoft.com/graph/throttling
- https://learn.microsoft.com/graph/throttling-limits
- https://learn.microsoft.com/graph/permissions-overview
- https://learn.microsoft.com/graph/permissions-reference
- https://learn.microsoft.com/entra/identity-platform/quickstart-register-app
- https://learn.microsoft.com/security/zero-trust/develop/identity-supported-account-types
- https://learn.microsoft.com/entra/identity-platform/consent-types-developer

### Local principle files

- `/Users/arnoldd/ai-best-practices/raw/rhyssullivan-mcp-beats-clis.md`
- `/Users/arnoldd/ai-best-practices/raw/trq212-mcp-better-than-clis.md`
- `/Users/arnoldd/ai-best-practices/raw/vasuman-spend-less-tokens.md`
- `/Users/arnoldd/ai-best-practices/raw/vasuman-five-principles-ai-that-ships.md`
- `/Users/arnoldd/ai-best-practices/raw/vasuman-if-ai-is-so-great-why-isnt-it-working.md`
- `/Users/arnoldd/ai-best-practices/raw/cloudflare-code-mode.md`
- `/Users/arnoldd/ai-best-practices/raw/tool-search-in-claude-code.md`
- `/Users/arnoldd/ai-best-practices/raw/lessons-building-claude-code-seeing-like-an-agent.md`
- `/Users/arnoldd/ai-best-practices/raw/gregisenberg-five-part-agent-test.md`
- `/Users/arnoldd/ai-best-practices/raw/exm7777-notable-posts.md`
- `/Users/arnoldd/ai-best-practices/raw/dynamic-workflows-in-claude-code.md`
- `/Users/arnoldd/ai-best-practices/raw/trq212-notable-posts.md`
- `/Users/arnoldd/ai-best-practices/raw/lessons-building-claude-code-how-we-use-skills.md`
