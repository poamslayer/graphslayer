# Ship local stdio first, keep the core transport-agnostic, host later

Version 1 runs as a local process a client starts with one `npx` line, the same install story as Lokka, which is local-only. A hosted version with team sign-in was the original plan, but it would require every first-time user to have a Cloudflare account and a deploy before their first query. So the core (connections, Graph client, sandbox, policy, audit, tools) takes its dependencies by constructor and knows nothing about the transport, and a self-hosted Cloudflare Worker is a second transport in a later version rather than a rewrite.

## Consequences

MCP OAuth and per-user identity on the server are out of scope until the Worker transport exists. Nothing under `src/core/` may import a transport or a Node-only sandbox directly.
