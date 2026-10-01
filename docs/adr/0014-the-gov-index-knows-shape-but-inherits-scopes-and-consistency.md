# The Gov index knows shape, but inherits scopes and the consistency header

ADR-0013 makes `graph_describe` accurate per cloud by subtracting the paths GCC High does not have. That subtraction can only be as good as the sources it is derived from, and the sources are lopsided in a way nothing in the code shows. This ADR records the asymmetry, because the alternative is discovering it from a customer's 400.

`scripts/build-index/sources.ts` names five sources. **Only one of them has a Gov equivalent.**

| Source | Supplies | Gov equivalent |
|---|---|---|
| `cleanMetadata.xml` (CSDL) | types, enums, consistency inputs | **yes** — the live `$metadata`, unauthenticated |
| `openapi.yaml` v1.0 | paths, `ConsistencyLevel` parameters | no |
| `openapi.yaml` beta | paths, `ConsistencyLevel` parameters | no |
| `permissions.json` | least privileged scopes | no |

Verified rather than assumed: `microsoftgraph/msgraph-metadata/openapi` contains exactly `beta` and `v1.0`, and `microsoft-graph-devx-content/permissions` contains `new` plus translation files. There is no `gov`, `usgov` or national cloud directory in either repository. Microsoft publishes the Gov schema only as a live service document, and publishes no Gov OpenAPI and no Gov permissions file anywhere.

So a Gov index is cloud correct about **shape** — which paths exist, which types and enums back them — and silently inherits commercial answers for two things that are not shape:

1. **The `ConsistencyLevel` header.** ADR-0009 makes the index the thing that decides this, derived from path level parameters in the OpenAPI, which is commercial only.
2. **Least privileged scopes.** From `permissions.json`, commercial only.

We ship it anyway, and write the asymmetry down rather than hiding it. The alternative is not a better index; it is no Gov support at all, because nothing published can derive those two for GCC High. This is the same shape of constraint as ADR-0011, where the default field selection is curated precisely because nothing published can derive it.

## Consequences

- **ADR-0009 is narrowed, not overturned.** The index decides the consistency header for a commercial connection. On a Gov connection that decision is inherited and unverified. The dangerous direction is a path that needs the header and is not marked as needing it, which fails as a 400 at call time; the old hard-coded list remains the fallback, exactly as ADR-0009 left it.
- **Describe must say the scopes are unverified on a Gov connection, not silently assert them.** `DescribeScopes` in `src/core/index/describe.ts` already models "not known", so the shape for saying it exists and no new vocabulary is needed. A least privileged scope advertised to a GCC High tenant may not be consentable there, and the research behind ADR-0013 found no published list of which ones.
- **Four Gov-only definitions are absent from the type dictionary.** GCC High declares `blockAccessAction`, `deviceRestrictionAction`, `notifyUserAction` and `restrictionTrigger`, which commercial does not, and a subtractive index cannot add them. Describe cannot explain a property typed by one. None of the five path bearing kinds has a Gov-only member, so no *path* is missing for this reason — only the explanation of a property on one.
- **One removal list serves both `.us` clouds.** The GCC High and DoD v1.0 documents are byte identical (MD5 `12e88144e5aacc1ac7e7666d457a5933`), so when DoD is added it needs an origin, not a second list or a second build.
- **The build now depends on a live service endpoint, not only on GitHub.** `graph.microsoft.us` serving `$metadata` anonymously is the single thread the Gov half of the index hangs from. It is cached under `.cache/graph-metadata` like every other source, so a rebuild costs no network, but if Microsoft ever requires authentication there, the Gov index cannot be rebuilt by someone without a GCC High tenant.

> Tool names changed in ADR-0017 (2026-10-01): `graph_describe` is now `search`, and `graph_run` and `graph_write` are now `execute`.
