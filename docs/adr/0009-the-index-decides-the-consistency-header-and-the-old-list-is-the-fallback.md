# The index decides the consistency header, and the old segment list is only the fallback

The Graph client sets `ConsistencyLevel: eventual` and `$count=true` on an advanced query when the Graph index marks the path, and falls back to plan 1's hardcoded list of first path segments when it does not. The index can only add the header, never remove it, because it records the presence of Microsoft's marker and is silent otherwise: 443 v1.0 paths carry the marker, and an absent marker says Microsoft did not mark the path, not that the header is unneeded. `/directory/administrativeUnits` carries none and still has documented advanced-query cases that need it. Reading absence as false would turn a working query into a Graph error, silently and in the direction that breaks calls.

## Considered options

- **The index is authoritative for every path it holds.** The cleanest rule, and it would remove the hardcoded list outright: 97 marker-only paths gain the header, and the nested resources under `/users` and `/groups` that are not directory-object collections lose one they never needed. Rejected because the index does not carry the evidence to drop a header. Microsoft's marker is one-directional by construction, and a path it does not mark may still need the header.
- **Derive the fallback from the index.** Read "does any path under this first segment carry the marker" instead of a literal list. It reads better and would settle `/directoryRoles` by rule rather than by hand. Rejected because it regresses `/me/messages`: `/me/memberOf` is marked, so every path under `/me` would inherit a header that mail filtering does not want, which is exactly the class of error the fallback exists to avoid.
- **Keep plan 1's rule and use the index only for the 404 hint.** Rejected because the header is where the index pays for itself inside `graph_run`. `/me/memberOf` is the common case a script reaches for, and it is one of the 75 paths under `/me` the hardcoded list never covered.

## `/directoryRoles` leaves the fallback list

It was in plan 1's list and carries no marker, and #23 is where that disagreement was settled rather than assumed. Microsoft's reference for `GET /directoryRoles` documents `$select`, `$filter` (`eq` only) and `$expand` as the query parameters it supports, and lists no `ConsistencyLevel` header. So the list was overbroad, and the `$count=true` that came with the header was a query option that path does not take. Confirmed against a live tenant: `GET /directoryRoles?$filter=displayName eq 'Global Administrator'` returns the role with no header and no `$count`. The other eleven segments stay, because nothing here is evidence about them.

## Consequences

- An unmarked path keeps plan 1's behaviour exactly, so removing the list as the *rule* is provably not a regression. The plan 1 tests pass unchanged, with no index passed at all.
- The client takes the same index loader `graph_describe` is given, so the file is read and parsed once for the whole server. A load that fails resolves to no index rather than throwing: the index improves a Graph call and never gates one, so a missing index falls all the way back to plan 1.
- A path in the index is a template and a call carries real ids, so the two are joined by a segment tree that prefers a literal branch and backtracks when it dead ends. `/users/delta` is the real `/users/delta`; `/users/delta/messages` is a user called "delta". Measured on the shipped v1.0 index: 12.6 ms to build the tree once over 11,546 paths, 0.3 µs a lookup, and 0.12 ms to suggest — and a suggestion is only ever computed for a call that already failed.
- The same tree answers a path Graph could not find with the closest paths it holds, so a near miss such as a singular resource name is one step from correct. It is deliberately narrow — a segment is offered only within a quarter of its length in edits — because an unrelated path is worse than no suggestion at all.
- "Could not find the path" is not the same as "404". Probed against a live tenant: `/user` comes back 400 `BadRequest` "Resource not found for the segment 'user'", while `/me/member` and a good path carrying a bad id both come back 404. The wrong first segment is the near miss the index is best placed to correct, so the hint reads that 400 as well. A 400 about the query itself is left alone.
- A `$batch` entry fails as data rather than as a thrown error, so it is hinted in its own place: the hint goes on the entry's error object, which the binding already spreads into what the script reads. One rule, two shapes, rather than a gap the model would only meet inside a batch.

> Tool names changed in ADR-0017 (2026-10-01): `graph_describe` is now `search`, and `graph_run` and `graph_write` are now `execute`.
