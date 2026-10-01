# The default field selection is curated, because nothing published can derive it

A collection read that passes no `$select` sends a curated list of fields for nine entity types, and nothing at all for every other type. The list lives on the entry in `types`, so a path reaches it through `entityType`. A single-object `get` never applies it, an explicit `select` always wins, and `select: ["*"]` sends no `$select` so Graph answers with its own projection. Measured across the six directory collections Graph returns whole, this takes a page of one hundred from about 188,000 tokens to about 33,500.

Microsoft publishes nothing that says which properties matter. There is no such field in the OpenAPI, the CSDL, or the permissions reference. This is the one part of the index that is a decision rather than a reading of Microsoft's description, and it is the reason this ADR exists: the consistency header is read from a marker, the enum members are read from the CSDL, and this is neither.

## Considered options

- **Derive it from the type: scalar properties in, navigation properties out.** The rule the spec gestures at, and the one that needs no curation. Rejected on measurement. `microsoft.graph.user` has 81 scalar properties against the 11 Graph itself returns for `GET /users`, so the derived default is **7.4 times wider** than what it replaces: it makes the response larger rather than smaller and inverts the point of having a default. It also selects `signInActivity`, which requires `AuditLog.Read.All`. Asking for a property the token has no scope for fails the whole call rather than omitting the field, so the derived rule would have broken reads that work today. The same shape holds for the other directory types: group 53 scalar, application 44, servicePrincipal 38.
- **Derive it, then subtract a blocklist** of navigation properties, properties needing extra scopes, and collection-valued complex properties. Fixes the breakage. Rejected because it does not fix the width: `/users` still lands near 60 fields against Graph's 11, so the token goal is still missed, and the blocklist is a hand-kept list with none of the curated list's advantage of being short enough to read.
- **Ship no default at all**, correct the spec, and let scripts shape their own reads. Honest, and it was a real option. Rejected because the measured win on the collections Graph returns whole is 82%, which is too large to leave, and because the failure it avoids is already avoided by the narrower rule below.
- **Curate per path rather than per type.** Rejected: the same type is returned by many paths, `/users` and `/users/{id}` among them, and a per-path table would have 320 entries restating nine facts. Keying by type also makes `/groups/{id}/members` correct for free, because it returns `microsoft.graph.directoryObject` and so gets no user fields.

## The rule is narrower than the spec's

Two deliberate restrictions, both of which reduce the chance of the quiet failure this feature risks.

**Collection reads only.** The token argument is about one hundred objects times their fields, not one object times its fields. A single-object `get` buys almost nothing and is the case most likely to hide a field the caller actually wanted, so `get` is left alone.

**Nine types, not every type with an entity type.** The default reaches 320 of 11,546 paths. Every other path behaves exactly as it did before. Most of Graph is read rarely and unpredictably, and a default there would be guessing on behalf of a caller who knows more than the index does.

## A hand-kept list is only defensible because the build checks it

The objection to a curated list is that it rots. Every curated property name is checked against the CSDL at build time, and a name that is not a real property of its type **fails the build** rather than warning. A curated entry for a type that no longer exists fails the same way, so a Graph rename cannot pass silently. That check is what makes this different from the hardcoded directory-path list ADR-0009 removed: that list had no source to check itself against, and this one is checked against the same metadata the rest of the index is built from.

The check is strict enough that it fires on a small test fixture, so `assembleIndex` takes the table as an optional input. A real build never passes it and always gets the shipped table.

## Consequences

- A script that wants the whole object writes `select: ["*"]`, which is spelled as a value rather than as the absence of one, because absence is what asks for the default. `BINDING_TYPES` says so in two lines, which is what the model actually reads.
- `graph_describe` reports a path's `defaultSelect`, so the shaping is inspectable rather than something the server does invisibly. A caller can see what they are not getting before they wonder why a field is missing.
- `all` walks through `list`, so it inherits the default rather than applying it separately. The second and later pages follow an absolute next link, which already carries the shaping from the first request.
- A path whose type carries no default, a path the index has no entry for, and a server whose index failed to load all behave exactly as they did before. The index improves a Graph call and never gates one.
- `/users` is the resource the ticket named and the one this helps least, at 15%, because Graph already narrows it to 11 fields. The win is on `/groups`, `/applications` and `/servicePrincipals`, which Graph returns whole. Recorded in `docs/measurements/2026-09-16-default-select.md`.
- The nine arrays cost under 1 kB on a 3.6 MB index. Cost was never the constraint here; correctness was.

> Tool names changed in ADR-0017 (2026-10-01): `graph_describe` is now `search`, and `graph_run` and `graph_write` are now `execute`.
