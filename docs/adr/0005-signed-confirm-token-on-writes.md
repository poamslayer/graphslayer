# Writes require a dry run and a server-signed confirm token

The write tool refuses to run a write unless the call carries a confirm token that the same tool issued from a dry run of the same tenant, method, path, and body within the last five minutes. The token is a keyed hash signed with a secret generated at server start, so the model cannot produce one without the dry run. We chose this over relying on MCP client confirmation prompts or elicitation, because not every client prompts on destructive tools and we cannot control which client a person uses. The tool is still annotated as destructive so clients that do prompt can prompt as well.

## Consequences

Every write costs two tool calls. Clients that support elicitation get no extra benefit in version 1.

> Superseded by ADR-0017 (2026-10-01): there is no dry run and no confirm token. The connection's mode is the only limit on writes.
