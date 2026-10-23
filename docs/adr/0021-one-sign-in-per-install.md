# One sign-in per install

An install of graphslayer is signed in to one tenant, and `execute` has no `tenant` argument. `graphslayer connect` replaces the sign-in, and `graphslayer disconnect` signs out. A second tenant is a second install with its own `GRAPHSLAYER_HOME`, added to the MCP client under its own name. This copies Cloudflare's MCP server, which has one sign-in per install and no account-switching tool. Arnold chose this on 2026-10-23 (#16): "We are adding too much complexity."

## Consequences

- Supersedes ADR-0004. A call no longer names its tenant. The tool's name in the client (for example `graphslayer-contoso`) says which tenant it acts on, and every result still carries the tenant id it ran against.
- One agent turn can still touch two tenants, by calling two installs' tools.
- An install upgraded from a version that held several sign-ins refuses to run `execute` until the person runs `disconnect` and `connect`, rather than guessing which one to use.
- Connecting again keeps a cached sign-in the old and new connections share, and clears the old one's stored credential (ADR-0015).
- ADR-0020's error that listed connection aliases is gone. With one sign-in there is nothing to choose.
