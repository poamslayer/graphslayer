# Building the Graph index

One command regenerates the **Graph index** the server ships:

```bash
npm run build:index                  # v1.0, writes data/graph-index.json
npm run build:index -- --refresh     # re-download Microsoft's metadata first
npm run build:index -- beta          # beta, writes data/graph-index-beta.json
```

Only v1.0 ships. The beta index builds from the same script and is not committed.

Each build also writes a Gov removal list beside its index — the paths GCC High does not have,
subtracted by `src/core/index/loader.ts` when a connection's cloud is `usgov-high`. It is derived
from the live Gov CSDL, cached like every other source, and it follows its index: the v1.0 list is
committed and published, the beta one is not. ADR-0014 says what that list can and cannot make
true.

At release time run it **with `--refresh`**, read the report it prints, run `npm test`, and
commit `data/graph-index.json` and `data/graph-index.report.json` together. Without
`--refresh` the build reuses whatever is in the cache, which is right while iterating on the
code and wrong for a release, because an index built from months-old metadata describes a
Graph that has moved and nothing in the file would say so.

## Prerequisites

- Node 22 or later.
- **python3 with PyYAML built against libyaml.** Check with
  `python3 -c "import yaml; yaml.CSafeLoader"`. The build converts Microsoft's OpenAPI from
  YAML to JSON once and then reads the JSON, because Node cannot read the YAML at all — see
  below. The build checks for the converter before it downloads anything, and stops with this
  instruction if it is missing.

A refresh downloads about 130 MB of Microsoft metadata into `.cache/graph-metadata`, which is
git-ignored, and the conversion writes another 97 MB of JSON beside it.

## What it writes

```jsonc
{
  "version": "v1.0",
  "builtAt": "2026-09-16",
  "types": {
    "microsoft.graph.user": { "properties": { "id": "Edm.String", "signInActivity": "microsoft.graph.signInActivity" } }
  },
  "paths": {
    "/users": {
      "methods": ["get", "post"],
      "consistency": true,
      "entityType": "microsoft.graph.user",
      "scopes": { "get": { "delegated": { "least": ["User.ReadBasic.All"], "all": ["User.Read.All", "User.ReadBasic.All"] } } }
    }
  }
}
```

**Nothing empty is ever written down.** The index says what Microsoft says and is silent
otherwise, so no shape in the file can be read as a claim the sources do not make:

- `entityType` is always a key into `types`. It is absent when the path returns no entity, and
  the build fails loudly rather than writing a name the table cannot hold.
- `consistency` is `true` only where Microsoft's description marks the path as needing
  `ConsistencyLevel: eventual`. **An absent flag is not a claim the header is unneeded** — the
  documentation has advanced-query cases with no marker, `/directory/administrativeUnits`
  among them. A consumer should fall back to its own rule rather than read absence as false.
- `scopes` covers only the methods the permissions reference reaches. A path it does not cover
  has no entry, a family it grants nothing under is absent, and `least` is absent when the
  reference marks none. **An absent entry means the index does not know, never that no scope
  is needed.**
- `alsoRequires` appears on a family whose scope is not sufficient alone. The reference says
  `Application.ReadWrite.All` on a token issuance policy also requires `Policy.Read.All`, and
  telling a person to consent to the first alone leaves the call still failing.

## The shape is forced, not chosen

Inlining every `$ref` the way Cloudflare's spec processor does cannot be built on Graph.
Measured on a 310-path sample of v1.0: 21 paths exceed 64 MB on their own, `/users`,
`/groups`, `/users/{user-id}` and `/groups/{group-id}` each exceed the entire isolate budget as
a single path, and the whole description projects to about 16 GB. The full build exhausts an
8 GB heap after about 123 seconds. Every directory object reaches `microsoft.graph.entity` and
drags the transitive closure with it. A shared type table is the only shape that works.

The budget it has to fit: `workerd` refuses a dynamic worker whose module source exceeds
`MAX_DYNAMIC_WORKER_CODE_SIZE`, a constant compiled into the binary at 67,108,864 bytes. The
measured usable budget is 63 MB placed as an object literal and 57 MB through `JSON.parse`.
The shipped index must stay under **32 MB**, which `test/scripts/build-index/graph-index.test.ts`
asserts against the committed file.

## Six defects that each produced a plausible but wrong index

Every one of these failed silently. The index still built; it was just wrong. Each has a test
in `test/scripts/build-index/`.

1. **Node cannot parse Graph's OpenAPI as YAML.** `js-yaml` exhausts an 8 GB heap on the 44 MB
   v1.0 document, because a JavaScript-level parser allocates far too much per node. The same
   document converted once with libyaml and read with `JSON.parse` costs 83 ms and 259 MB.
2. **Graph keys success responses `2XX`, not `200`.** Reading `200` — which is what an OpenAPI
   written by hand would use — leaves the entity type null on all 11,546 paths. Verified: with
   the `200`-only lookup the build resolves 0 types and reports 6,033 unclassified paths.
3. **Collection schemas put the pagination envelope first in `allOf`.** Walking `allOf` in
   order returns `BaseCollectionPaginationCountResponse` and never reaches
   `microsoft.graph.user`. Verified: it pushes the count past 8,000, because thousands of
   paths resolve to an envelope instead of an entity.
4. **The CSDL writes type references through a schema alias.** `microsoft.graph` is written
   `graph` and `microsoft.graph.security` is written `self`. Left unresolved,
   `BaseType="graph.directoryObject"` matches nothing, so `microsoft.graph.user` loses `id`
   and every inherited property, and a property typed `graph.signInActivity` names a key the
   table does not have.
5. **A nullable single entity is wrapped in `anyOf`.** Graph writes a nullable return as
   `anyOf: [ { $ref: microsoft.graph.workbookRange }, { type: object, nullable: true } ]`.
   A resolver that reads only `$ref` and `allOf` misses **697 paths** across 29 entity types —
   and, worse, they do not show up as failures, because the paths land in the `function`
   bucket and the counts look healthy.
6. **A real entity can be named like an envelope.** `microsoft.graph.deviceLogCollectionResponse`
   is an entity type in the CSDL. A `CollectionResponse` suffix rule quietly resolved its item
   paths to `microsoft.graph.entity`. A collection is recognised by carrying `value`, which is
   checked first, so the suffix rule bought nothing and cost this.

## Types come from the CSDL, not the OpenAPI schemas

The CSDL XML is the file the OpenAPI is generated from. It is 3.6 MB against 44 MB, parses in
about a tenth of a second, and yields a tighter table for the same paths.

## Measured, on the build that produced the committed index

| | v1.0 | beta |
|---|---:|---:|
| Paths | 11,546 | 18,583 |
| Paths with an entity type | 6,858 | 10,899 |
| Types | 3,034 | 5,890 |
| Paths Microsoft marks for the consistency header | 443 | 576 |
| Paths the permissions join reached | 3,486 | 5,771 |
| Types with a curated default `$select` | 9 | 9 |
| Paths reaching one | 320 | 432 |
| Enums | 876 | 1,888 |
| Enum members | 6,419 | 12,490 |
| Index size | 3.9 MB | 7.2 MB |
| Peak build memory | about 290 MB | about 355 MB |
| Wall time, sources cached | about 0.4 s | about 0.6 s |

Memory and timing are the machine's, so they move a little between runs; the exact figures for
the build that produced the committed index are in `data/graph-index.report.json`.

Peak memory is why this runs on a machine and not in a Worker, which has 128 MB.

Install effect, measured with `npm pack --dry-run` on the build that produced the committed
index: the whole package is **309.1 kB packed and 3.9 MB unpacked** across 57 files, against
26.6 kB and 106.8 kB without the index. The index file itself is 3.6 MB of that unpacked size.
Set against the roughly 170 MB install that ADR-0006 records, most of which is the `workerd`
binary, this is about 2%.

Untyped paths, all of them accounted for:

| Kind | v1.0 | beta | Why it has no entity type |
|---|---:|---:|---|
| `count` | 2,153 | 3,566 | `$count` returns an integer |
| `action` | 2,086 | 3,470 | no GET, so there is no read to take a type from |
| `media` | 208 | 299 | the GET returns bytes rather than JSON, such as a photo |
| `function` | 152 | 213 | an OData function call whose return has no named type |
| `ref` | 82 | 124 | `$ref` returns a link |
| `enum` | 7 | 12 | the GET returns a bare enum, which has no properties |
| unclassified | 0 | 0 | — |

The kinds describe the path's shape, not a claim about its nature: `action` means only that
there is no GET, and `/places` is a write-only resource that lands there alongside the real
actions.

A path that fits none of these is printed by name at the end of the build, as is any type name
that resolves to neither a type nor an enum. Those two lists are the alarm for a resolver
defect or a shape Microsoft has started using, so a build that prints either is a build to
look at rather than a build to ship. **A bucket must never become somewhere failures can
hide** — defect 5 above sat in the `function` bucket with the totals looking healthy.

### Why this is 3.9 MB when the prototype measured 15.7 MB

Smaller is not evidence that something was lost here. Measured against the prototype's
`v1.0-C-csdl-join.json`, which is 16.5 MB:

- **10.8 MB of it is per-operation `summary`, `description` and `parameters`**, which the
  prototype kept only so its progressive-drop builds could measure what prose and parameter
  lists cost. The server does not need any of it.
- **0.4 MB is `defaultSelect`**, which this ticket excludes because the rule is undecided.
- Going the other way, **0.15 MB of this index is the `enums` table**, which the prototype had
  no equivalent of. It is 4.3% of the file and buys the permitted values of every enum a
  property can name.
- The **types table is bigger here**, 941 kB against 663 kB, for the same 3,034 types. The
  alias fix put 3,744 property types back into the form the table is keyed by, and restored
  the inherited properties: the prototype's `microsoft.graph.user` has 136 properties and no
  `id` at all, where this one has 138 including `id` and `deletedDateTime`.

Every type in the prototype's table is in this one, and this index resolves 690 more paths
than the prototype did.

## Known gaps

- **The permissions join reaches 30% of paths** (3,486 of 11,546), and #25 established that
  this headline is the wrong measure. Coverage is **62% of the reads at one or two literal
  segments**, **100% of the 26 entry points an assessment actually uses**, and 0.7% six
  segments deep, which is most of Graph and none of the traffic. It will not get much better:
  85% of the reference paths that miss are beta-only or name features neither description has
  published, so no normalization reaches them, and there is no other source to switch to. The
  build stores what joins and leaves the rest absent, which is what lets a consumer tell
  "unknown" from "none needed". `docs/research/2026-09-16-permissions-join.md` has the failure
  modes, the counts and the decision; `graph-index.test.ts` guards the 26 entry points.
- ~~A property's type can name an enum, which the table does not hold.~~ **Closed.** The index
  carries an `enums` table beside `types`, keyed the same way, holding member names in CSDL
  declaration order and an `isFlags` marker where the CSDL sets one. v1.0 has 876 enums and
  6,419 members for 0.15 MB, 4.3% of the file; 816 of them are named by a property in `types`,
  which is the figure this gap was originally measured at. `graph-index.test.ts` now asserts
  over the whole shipped file that every non-primitive property type resolves to an entry in
  `types` or in `enums`, with no exceptions list, so this cannot silently reopen.

  The table holds member **names** only. The CSDL also gives each member an integer, and Graph
  accepts the name in a `$filter`, so the integer is the half that is not useful here. 66 v1.0
  enums are `IsFlags`, where a value combines members; they carry the marker because a
  consumer reading the members alone would otherwise not know that.
- **The consistency flag is one-directional.** Presence is Microsoft's own marker; absence is
  only the absence of a marker. Until something better exists, a consumer needs its own
  fallback for unmarked paths.
- ~~No default field selection.~~ **Closed, narrowly.** Nine entity types carry a curated
  `defaultSelect`, reaching 320 of the 11,546 paths through `entityType`. It is curated rather
  than derived because nothing Microsoft publishes says which properties matter, and deriving
  it mechanically was measured as 7.4 times *wider* than what Graph already returns for
  `/users`. Every curated name is checked against the CSDL and a name that is not a real
  property fails the build. ADR-0011 has the rule; `docs/measurements/2026-09-16-default-select.md`
  has the numbers. Every other path still sends no `$select`, which remains the honest default
  for the parts of Graph nobody has looked at.

## Prior art

The prototype that measured the size question is on the `prototype/graph-index` branch under
`scripts/build-index/prototype/`, with the numbers in its `README.md`. It is a primary source,
not code to merge — and it carries defects 4, 5 and 6 above, so its type table and path counts
should not be treated as a target.
