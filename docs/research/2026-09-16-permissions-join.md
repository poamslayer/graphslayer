# Why the permissions join resolves 19% of paths, and what to do about it

Research for #25. Every number here was measured against `.cache/graph-metadata/permissions.json`,
`.cache/graph-metadata/openapi-v1.0.json`, `.cache/graph-metadata/csdl-v1.0.xml` and the shipped
`data/graph-index.json`. The scripts are on the gitignored
`scripts/build-index/prototype/perm-join/`.

## Summary

The join is not broken. It is measuring the wrong thing.

19.20% counts every path in Graph equally, and most of Graph is a long tail of `$count` segments,
actions, and navigation five and six levels deep that nobody calls. On the paths a run actually
reads, coverage is **58.7%** at one or two literal segments, and **26 of the 26** entry points an
assessment uses have their delegated GET scopes. Four mechanical fixes take the headline from
19.20% to **31.31%** for about twenty lines of code.

**Recommendation: 403-to-scope can ship.** Not as "the index names the missing scope", which is
the claim the ticket rightly says would be worse than nothing, but as a three-source answer that
is honest about which source spoke. Details in the last section.

## How the join works today

`scripts/build-index/scopes.ts` reads Microsoft's permissions reference into a map keyed by
normalized path, then by lowercase method. `normalizeScopePath` is the whole of the
normalization:

```ts
path.toLowerCase().replace(/\{[^/{}]+\}/g, "{id}")
```

Lowercase, and every `{parameter}` rewritten to `{id}`. `scopesFor` applies the same function to
the OpenAPI path and looks it up. A miss writes nothing, which is what keeps the index honest:
a path the reference does not cover has no `scopes` entry at all, and there is no shape a
consumer can read as "no scope needed".

| | Count |
|---|---:|
| Paths in the permissions reference (normalized, v1.0) | 7,388 |
| Paths in the v1.0 description (normalized) | 11,546 |
| Matched | **2,217** |
| Unmatched, reference side | 5,171 |
| Unmatched, description side | 9,329 |

## Failure modes, ranked

Of the 5,171 reference paths that match nothing:

| Failure mode | Paths | Share |
|---|---:|---:|
| No counterpart in either published description | 2,671 | 51.7% |
| Beta only, not a v1.0 path at all | 1,733 | 33.5% |
| Function or action spelled another way | 382 | 7.4% |
| Trailing cast, `$ref`, `$value` or `()` | 280 | 5.4% |
| Shorter vocabulary than the description uses | 105 | 2.0% |

**The top two, 85.2% together, are not spelling problems at all.** The permissions reference and
the OpenAPI description are published on different schedules and cover different surfaces. This
is the single most important finding, because it means the join cannot be fixed by normalizing
harder.

### The mechanical differences, with example pairs

These four are real and fixable. The count against each is the number of **description** paths
it newly joins, measured cumulatively in the order listed, which is the figure that matters for
coverage. It differs from the reference-side bucket counts above because several reference paths
can collapse onto one description path and the other way round.

**1. Function parameters are quoted in one and not the other.** Joins 125 description paths.

```
reference:   /identitygovernance/accessreviews/definitions/filterbycurrentuser(on={id})
description: /identitygovernance/accessreviews/definitions/filterbycurrentuser(on='{id}')
```

**2. A trailing type cast.** Joins 256 description paths. The description carries the cast segment; the reference
does not. Note the description uses the CSDL *alias*, `graph.`, not `microsoft.graph.`:

```
reference:   /directoryroles/{id}/members/{id}
description: /directoryroles/{id}/members/{id}/graph.application
```

**3. A trailing `$ref`, `$value` or `$count`.** Joins 907 description paths, the largest single mechanical win.
The reference documents the scope for the collection; the description enumerates the OData
segments separately. A `$count` on a collection needs the same scope as the collection, so
joining them is correct rather than merely convenient:

```
reference:   /groups/{id}/members
description: /groups/{id}/members/$ref
```

**4. A trailing empty `()`.** Joins 110 description paths, on parameterless functions: `delta` against `delta()`.

### The differences that are not mechanical

**5. A shorter vocabulary.** 105 paths. The reference names a resource by its friendly top-level
path; the description gives the full navigation path.

```
reference:   /accessreviews
description: /identitygovernance/accessreviews
```

```
reference:   /administrativeunits/{id}/members/{id}
description: /directory/administrativeunits/{id}/members/{id}
```

This one is a trap. Matching on a path suffix would join these correctly and would also join
things that must not be joined, because a tail like `/members/{id}` is shared by many resources
with different scopes. It is not worth 105 paths.

**6. The reference ships ahead of the description.** 1,523 of the residual name features that
are in neither published description: `cloudLicensing`, `agentIdentity`, `agentRegistry`. These
are not errors in either file. The permissions reference is updated when a permission is
defined, which is before the API description is regenerated.

**7. Two reference entries carry a query string**, such as
`/agentregistry/agentinstances?$filter=agentcardmanifest/id eq '{id}'`. Two paths. Noted only so
that nobody rediscovers it as though it mattered.

## The other direction

9,329 description paths match no permission. Sampled and classified, this is dominated by the
same long tail: `/drives` (1,592 unmatched), `/identityGovernance` (1,420), `/groups` (1,150).
Not a separate problem, the same one seen from the other end.

## The CSDL annotation lead is dead

The ticket names annotations in the CSDL as a lead worth checking. It was checked, and it is not
one.

The v1.0 CSDL carries 6,280 annotations across 32 distinct terms.
`Org.OData.Core.V1.Permissions` appears 88 times and looks like the answer until you read one:

```xml
<Annotations Target="microsoft.graph.androidStoreApp/packageId">
  <Annotation Term="Org.OData.Core.V1.Permissions">
    <EnumMember>Org.OData.Core.V1.Permission/Read</EnumMember>
  </Annotation>
</Annotations>
```

That is OData's property-level read/write marker. `Permission/Read` means the property is
read-only. It has nothing to do with OAuth scopes. Nothing else in the 32 terms carries a scope
name, and a search for `OAuthScopes`, `ScopeName` and `SecurityScheme` returns zero hits.

**The CSDL carries no Graph permission data.** The permissions reference is the only published
source, so there is no source to switch to. Licence and regeneration questions do not arise.

## What the mechanical fixes actually buy

Applying fixes 1 to 4, cumulatively:

| Normalization | Matched | Coverage |
|---|---:|---:|
| Today: lowercase and `{id}` | 2,217 | 19.20% |
| plus unquote function parameters | 2,342 | 20.28% |
| plus drop a trailing type cast | 2,598 | 22.50% |
| plus drop trailing `$ref`/`$value`/`$count` | 3,505 | 30.36% |
| plus drop empty `()` | 3,615 | **31.31%** |

A 63% relative improvement for four regular expressions.

**But the headline flatters it.** Restricted to paths that are a real read, meaning a GET that
returns an entity type, with no `$count`/`$ref`/`$value` segment and no cast:

| Population | Paths | Today | After the fixes |
|---|---:|---:|---:|
| All real GET reads | 6,328 | 24.9% | **27.2%** |
| Depth 1 to 3 | 2,346 | 53.0% | **56.1%** |
| Depth 1 to 2 | 941 | 58.7% | **62.0%** |

Most of the raw gain is on `$count` and `$ref` paths, which are not reads anyone makes. The
fixes are still worth taking, because they are twenty lines and they make the reported number
mean something. They do not change the decision.

## Coverage where it matters

Scope coverage against path depth, counting literal segments only, over real GET reads:

| Literal segments | Paths | With scopes | Coverage |
|---:|---:|---:|---:|
| 1 | 114 | 53 | 46.5% |
| 2 | 827 | 499 | **60.3%** |
| 3 | 1,405 | 691 | 49.2% |
| 4 | 1,306 | 243 | 18.6% |
| 5 | 751 | 77 | 10.3% |
| 6+ | 1,925 | 14 | 0.7% |

Coverage collapses with depth, and the 19.20% headline is mostly the bottom two rows.

Against the paths an assessment actually reads, **26 of 26 have their delegated GET scopes**:
`/users`, `/users/{id}`, `/users/{id}/memberOf`, `/users/{id}/licenseDetails`, `/groups`,
`/groups/{id}`, `/groups/{id}/members`, `/groups/{id}/owners`, `/devices`, `/devices/{id}`,
`/applications`, `/applications/{id}`, `/servicePrincipals`, `/servicePrincipals/{id}`,
`/directoryRoles`, `/directoryRoles/{id}/members`, `/identity/conditionalAccess/policies`,
`/identity/conditionalAccess/namedLocations`, `/subscribedSkus`, `/organization`, `/domains`,
`/auditLogs/signIns`, `/auditLogs/directoryAudits`, `/policies/authorizationPolicy`,
`/roleManagement/directory/roleAssignments`,
`/reports/authenticationMethods/userRegistrationDetails`.

That list was written before it was measured, from what plan 1's task tools would read, so it is
not a list chosen because it passed.

## Recommendation

**Ship 403-to-scope, sourced in this order, and always say which source answered.**

1. **Graph's own error body first, when it names a permission.** It is always right, needs no
   join, and covers exactly the paths the index does not. *This has not been verified against a
   live tenant and must be before it is built.* The common `Authorization_RequestDenied` body,
   "Insufficient privileges to complete the operation", names nothing, so the question is what
   share of 403s carry more than that. Probing it is the first task of the implementing ticket.
2. **The index, when it has an entry**, which is 58.7% of shallow reads today and 62.0% after
   the mechanical fixes, including every entry point listed above.
3. **"The index does not know", explicitly**, otherwise. The index already carries this
   correctly: an absent `scopes` entry is absent, never empty, and #21 already requires
   `graph_describe` to distinguish "needs no scope" from "not known". The failure the ticket
   warns about, a result that names no scope reading as "this is not a permissions problem", is
   a presentation bug, not a data problem. It is avoided by naming the gap rather than omitting
   it.

### The coverage bar

A percentage over 11,546 paths is not a bar worth agreeing, because it is dominated by paths
nobody calls. The bar is a list:

**Must join, and all 26 do today:** the entry points above.

**Should join, measured at 62.0% after the mechanical fixes:** real GET reads at one or two
literal segments.

**Explicitly not required:** navigation four or more levels deep, `$count`, `$ref` and `$value`
segments, actions, and `/deviceManagement`. These answer "the index does not know", which is
true and is useful.

**Regression guard:** a test asserting all 26 entry points resolve to delegated GET scopes in
the shipped index. That is what stops a future index rebuild quietly losing them, and it is
worth more than any percentage.

### Also do

Take the four mechanical fixes. Twenty lines, 19.20% to 31.31% of description paths, and the
reported coverage figure starts describing something real.

**One correction, found in review after this was first written.** The cast rule must match the
alias spelling `graph.user` only, and not `microsoft.graph.security.moveAlerts`. Those are
namespaced actions, not casts, and stripping one hands the action whatever the collection
beneath it is granted: `moveAlerts` inherited `SecurityAlert.Create.All` from
`/security/alerts_v2`, which the reference says nothing about, and four eDiscovery hold actions
did the same. The split was then checked rather than assumed: in v1.0 all 300 trailing
`graph.<name>` segments are type casts and all 78 `microsoft.graph.<namespace>.<name>` segments
are not. The shipped index joins 3,486 paths rather than 3,499, and the thirteen it gives up
were all scopes the reference never stated.

### Do not do

Suffix matching to fix the shorter-vocabulary case. It joins 105 paths correctly and risks
joining unrelated resources that share a tail, which would put a confidently wrong scope name in
front of a person. Wrong is worse than unknown here.

## What this means for the spec

The spec's error handling says a 403 is mapped to the missing scope using the Graph index, full
stop. That is not what should be built. The spec needs correcting to the three-source rule above,
including the explicit unknown case. Whether the permissions join is "good enough" was the wrong
question: it is good enough for the paths that matter and will never be good enough everywhere,
and the design has to state both.
