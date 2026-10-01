# What `graph_describe` query mode costs

Measured 2026-09-16 on the committed `data/graph-index.json` (v1.0, 3,572,966 bytes, 11,546
paths, 3,034 types), Node 22 on an M-series Mac. Every number below is printed by a test, so it
can be re-measured rather than trusted.

## Loading the index

| What | Measured |
|---|---|
| Read and parse `data/graph-index.json` | **25.7 ms** |
| File size | 3,572,966 bytes |
| Heap after parse | ~24 MB |

The index is loaded once per server process, not once per call: `createIndexLoader` memoises the
promise, so concurrent first calls share one read (`test/core/index/loader.test.ts`). Registration
does not load it — the cost is paid on the first `graph_describe` call and never again. Measured
over stdio against the built server: first call 210 ms including process start, third call 15 ms.

A failed read is not cached, so a transient failure does not poison the tool for the life of the
process.

## Searching

| Query shape | Measured |
|---|---|
| One term (`user`) over 11,546 paths | **11.0 ms** |
| A sentence (`what properties does a user have in tenant contoso`) | **50.3 ms** |
| No match (`zzzznotathing`), including the closest-path fallback | **130.9 ms** |

A sentence costs more because it is scanned once as a whole and then once per significant word,
and the closest-path fallback runs an edit distance over every path. Both are worst cases that
only run when the cheap path found nothing.

## What a result costs the model

| Query | Characters | ≈ tokens |
|---|---|---|
| `user` | **11,609** | ~2,900 |
| `conditionalAccess` | **4,003** | ~1,000 |

`user` is the heavy end of typical: the entity carries all 138 properties Microsoft gives a user
in v1.0. The list is deliberately not shortened — "what properties does a user have" is the
question this tool exists to answer, and a quietly truncated list answers it wrongly while
looking complete. `entity.propertyCount` is always the true total.

Both sit well inside the 40,000 character cap a `graph_run` result gets. The bound in
`test/core/tools/graph-describe.test.ts` is set to catch a regression that doubles the cost, not
to squeeze the number.

## What the enum table added

`#27` gave the index an `enums` table, so a property typed `microsoft.graph.riskLevel` can carry
its permitted values rather than only its name. Members are inlined on an entity's property up
to twelve, which covers **1,438 of the 1,575 enum-typed property references** in v1.0; the other
137 carry the enum's name and member count so the caller knows there is something to ask for,
and a query naming an enum directly returns it in full whatever its size.

The cap is what keeps this affordable. The largest enum in v1.0 is
`microsoft.graph.printerProcessingStateDetail` with **826 members**, and it is referenced by
`microsoft.graph.printerCapabilities`; inlining it unconditionally would cost more than the rest
of that entity put together.

Measured on the shipped index, describing an entity, before and after:

| Entity | Properties | Enum-typed | Before | After | Change |
|---|---:|---:|---:|---:|---:|
| `user` | 138 | 0 | 8,512 | 8,512 | **+0%** |
| `device` | 37 | 0 | 2,003 | 2,003 | **+0%** |
| `servicePrincipal` | 56 | 0 | 3,751 | 3,751 | **+0%** |
| `group` | 81 | 1 | 4,932 | 5,066 | +3% |
| `conditionalAccessPolicy` | 11 | 1 | 643 | 791 | +23% |
| `riskyUser` | 10 | 3 | 528 | 894 | +69% |
| `managedDevice` | 62 | 9 | 3,736 | 4,950 | +32% |
| `windows10GeneralConfiguration` | 213 | 25 | 13,964 | 17,193 | +23% |

Bytes of the rendered property list.

The result worth noting is that **the directory resources cost nothing**. `user`, `device` and
`servicePrincipal` have no enum-typed properties at all, so the common describe is byte for byte
what it was. The cost lands on the Intune configuration types, which are enum-heavy by nature:
`windows10GeneralConfiguration` is the largest absolute increase at 3.2 kB, and it was already
the largest entity in the index. The percentages look worst on the small entities, where a
handful of member lists is most of a short result, and `riskyUser` at +69% is 366 bytes.

## Where the cost goes instead

The point of paying this is that `graph_run`'s description does not have to. It stays at about
2,000 characters of binding types and three examples, with nothing resource-specific in it,
because everything resource-specific is one describe call away.
