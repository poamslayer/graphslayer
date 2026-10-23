# Tenants are managed from the terminal, not by the agent

The server no longer has `connections_list`, `connection_add` or `connection_remove`. The agent sees `docs`, `search` and `execute`, the same three tools as Cloudflare's server (ADR-0017). A person adds a tenant with `graphslayer connect`, lists them with `graphslayer connections` and removes one with `graphslayer disconnect <alias>`. Arnold chose this on 2026-10-23 (#14): the connection tools were "too confusing honestly".

It is also a narrower surface. `connection_add` let the agent start a sign-in and ask for the read-write template, so the agent could propose widening its own access. Now only a person at a terminal can add a connection or change its mode.

The agent still needs a tenant alias for every `execute` call (ADR-0004). A call naming a tenant that does not exist returns an error listing each connection's alias, tenant name, cloud and mode. That error is now the only way the agent learns the aliases, so it never includes scopes, user names or anything secret.

## Consequences

- `graphslayer disconnect` is new, because `connection_remove` was the only way to remove a connection. It keeps the rules that tool had: it clears the cached sign-in only when no other connection uses the same account (ADR-0015), and it clears an app-only or agent credential from the secret store without failing if the entry is already gone.
- The agent can no longer read a connection's granted scopes. `graphslayer connections` prints them as its last column, for the person.
- `tools/list` is smaller by the three connection tools' definitions.

> Updated by ADR-0021 (2026-10-23): with one sign-in per install, execute no longer lists aliases, and `graphslayer disconnect` takes no argument.
