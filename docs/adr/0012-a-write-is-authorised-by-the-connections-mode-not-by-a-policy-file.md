# A write is authorised by the connection's mode, not by a policy file

The spec proposed a policy engine: a JSON file of rules naming a method, a path pattern and optionally resource ids, with all writes off until a person adds one. We are not building it. A connection is instead added under one of two scope templates, read or read-write, and the write tool refuses when the connection was added as read. Cloudflare's production server is the model: it gates writes on the consent the person chose and has no policy layer, no dry run and no confirmation anywhere in its source (see `docs/research/cloudflare-mcp-code-mode-reference.md`).

Their model does not port whole, because Entra's consent differs from Cloudflare's own OAuth server in two ways we verified:

- **A consent request is capped**, at about 155 delegated permissions and about 300 application permissions. Our index holds 635 distinct scopes, 281 of them read, so "every scope" is not expressible and even "every read scope" is not. A shipped read set is chosen by hand, once, from a mechanically ranked shortlist.
- **Consent is cumulative and belongs to the application and tenant, not to the connection.** Entra returns every scope previously consented for the resource whatever the request asks for, and ADR-0003 deliberately uses Microsoft's shared Graph Command Line Tools app *because* it is already consented in most tenants. `src/core/auth/msal.ts` compounds this: every token after sign-in is acquired with `https://graph.microsoft.com/.default`, which asks for everything consented. A connection's token is therefore routinely wider than the scopes it was created with, and narrowing the request would not narrow the token.

So the scope template is what we *ask* for and can never be what we *enforce*. The mode is a field on the connection, checked in the write tool before the request is built. It carries no paths, no patterns and no resource ids; it is the one piece Cloudflare gets free from running its own authorisation server.

## Consequences

- **A write cannot be restricted to particular objects.** A connection that may change groups may change every group in that tenant, because no Graph scope is resource-scoped. This is the capability we traded away, and rules can be added later if a real case appears.
- **App-only connections get no template.** The client credentials flow must request `.default`, so an app-only connection takes whatever permissions an administrator granted the registration. Mode is the only control on that path.
- `policy_show` is dropped from the tool surface. `connections_list` already returns each connection's granted scopes, which answers the same question.
- ADR-0005 stands. The confirm token is now the only step between the model choosing a write and the write happening, which raises its value rather than lowering it.

> Updated by ADR-0017 (2026-10-01): the write tool is gone, and `execute` writes. This mode check is now the only limit on a write, and it runs inside the binding before anything is sent.
