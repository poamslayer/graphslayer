# Delegated sign-in by default, using the Microsoft Graph Command Line Tools app id

Delegated sign-in is the default so every call runs as a real person and the audit log names them. The default client id is `14d82eec-204b-4c2f-b7e8-296a70dab67e`, which Microsoft Learn lists as "Microsoft Graph Command Line Tools", a Microsoft tenant-owned application already consented in most tenants. We chose it over shipping our own multitenant app registration, because a project-owned app would put a third party's application into every user's tenant and make the maintainer responsible for it. A deployer can set their own client id in config. App-only connections are an opt-in, not the default, because application permissions bypass the user and are the higher-risk path.

## Considered options

- A project-owned multitenant app, as Lokka's public source does. Rejected for the governance reason above.
- Require every user to register their own app before first use. Rejected because it breaks the one-line install.

## Consequences

Consent belongs to the application, not to this server. The Graph Command Line Tools app is shared with Graph PowerShell and the Graph CLI, so every connection inherits whatever consent those tools already collected in a tenant, including tenant-wide admin consent. A sign-in that requests two scopes can get a token that carries a dozen. The consent is still correct: the sign-in grants exactly what it asked for, and Entra issues a token carrying everything the application holds.

Because of this, a connection stores its requested scopes beside its granted scopes. When the token is wider than the request, adding the connection says which scopes are inherited and why (#66). Connection mode, not the token, is what decides whether a connection may write (ADR-0012). A client id per connection, so that one tenant can have a narrow connection, is the planned mitigation for the breadth itself (#70).

> Superseded in part by ADR-0016 (2026-10-01): the server keeps no local audit log, so where this record mentions audit lines, Microsoft's own logs are the record now.
