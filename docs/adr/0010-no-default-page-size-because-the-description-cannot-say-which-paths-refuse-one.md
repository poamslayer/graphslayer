# No default page size, because the description cannot say which paths refuse one

`GraphClient.list` sends `$top` only when the script passes one, and `all` no longer forces a page size on every page. Graph applies its own default instead, which is 100 for most directory collections. A script that passes `top` still gets it, capped at 999.

Plan 1 sent `$top=50` on every list and `$top=999` on every page of an `all`. Some collections refuse a page size outright and answer `400 Request_UnsupportedQuery`, "This resource does not support custom page sizes. Please retry without a page size argument." Measured against a live tenant, `/subscribedSkus`, `/directoryRoles` and `/directoryRoleTemplates` all fail this way through `list` and `all`, while `/users`, `/groups`, `/domains` and `/organization` work. Because the page size was added by the client rather than by the script, `QueryOpts.top` had no value meaning "send none", so those paths were unreachable through `list` and `all` and only `get` could read them. `/subscribedSkus` is the one that hurt: licensing is a common assessment read, and `get` is the operation a model is least likely to reach for on a collection.

## The index cannot answer this one

The reflex after ADR-0009 is to read a per-path flag from the Graph index, the way the consistency header is now read. That cannot be derived. Verified against `.cache/graph-metadata/openapi-v1.0.json`: 2,583 of the 9,424 GET paths declare `$top`, and every one of them declares it as the same `$ref` to `#/components/parameters/top`. The three paths that refuse a page size at runtime and the four that accept one carry byte-identical declarations. Unlike the `ConsistencyLevel` header, which `/users` carries as a path-level parameter and `/subscribedSkus` does not, there is no marker here to read. The information is not in the description, so no amount of index building will produce it.

That shared component is also where the old default most likely came from: it carries `"example": 50`.

## Considered options

- **Retry once without the page size** when Graph answers this exact 400. Self-correcting and needs no per-path knowledge. Rejected because it spends a call from the run's 200-call cap to learn something the server could have simply not done, and it pays that cost on every first touch of such a path in every run. It also couples the client to the wording of a Graph error message, which is the kind of match that breaks quietly when the wording changes.
- **A hardcoded list of paths that refuse a page size.** Works today. Rejected because it is exactly the kind of hand-kept list ADR-0009 removed, with the same failure mode: wrong the moment Graph changes, and wrong silently. There is no source to regenerate it from, so it could only ever be grown by someone hitting the bug again.
- **Keep the default and document the failure.** Rejected outright. The failure is a 400 with no path to a working call, and a script has no way to opt out.

## Consequences

- `graph.list("/subscribedSkus")` and `graph.all("/subscribedSkus")` return the licences, and a script reaches a collection that refuses a page size without knowing that it does.
- The predictable small first page is gone. A `list` with no `top` now returns whatever Graph defaults to, which is 100 for most directory collections rather than 50, so an unshaped first page is about twice the tokens it was. A script that wants a small page passes `top`, and the run tool's type declarations say so.
- `all` costs more calls. Walking to the 2,000-item default at Graph's 100-per-page is about 20 calls where the forced 999 made it 3. That is well inside the 200-call cap, and a script that wants the old behaviour passes `top: 999`, which works on every collection that accepts a page size. The declarations tell the model this buys fewer calls.
- Paging itself is unchanged. A cursor is followed as an absolute next link and never had a page size applied to it.
- This is the one place where the client guesses less by doing less, rather than by reading the index. It is worth saying plainly that the index was the first answer tried and the description did not support it.
