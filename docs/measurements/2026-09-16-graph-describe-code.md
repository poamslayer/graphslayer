# What an index run costs

Measured 2026-09-16 on the committed `data/graph-index.json` (v1.0, 3,572,966 bytes, 11,546 paths,
3,034 types), Node 22 on an M-series Mac. Every number below is printed by a test or by a run
against the built server over stdio, so it can be re-measured rather than trusted.

An **index run** is `graph_describe`'s `code` mode: a script the agent writes, executed against the
Graph index in a sandbox with no network at all. See ADR-0008 for why that sandbox is a second one
rather than the run sandbox with an argument.

## Running a script over the index

Measured over stdio against `dist/cli/main.js`, with no connection registered:

| What | Measured |
|---|---|
| First index run (starts `workerd`, places the index) | **100 ms** |
| A later index run | **29 ms** |
| Same, inside the test process (`test/transport/stdio/index-run.test.ts`) | 76 ms first, 27 ms warm |

The warm number is not a cache hit. An index run pays the placement every time, because the Worker
Loader caches by worker id and every run gets its own id. 29 ms is what it costs to hand 3.4 MB of
object literal to a fresh isolate. ADR-0008 predicted this from a prototype that measured 141 ms for
a 15.7 MB index; scaled to the shipped 3.4 MB that is about 30 ms, which is what came out.

The index is placed as an **object literal**, not through `JSON.parse`. Measured budget under
`workerd`'s 64 MiB `MAX_DYNAMIC_WORKER_CODE_SIZE` is 63 MB as a literal against 57 MB parsed,
because escaping the JSON into a string inflates the source about 1.16x. The shipped index uses
3.4 MB of that.

## What the first run costs beyond the script

Nothing is spent until an agent actually writes a script. The index sandbox is built on the first
index run and not before, so a server that only ever answers `query` calls never starts a second
`workerd` process and never holds the index source. `test/core/tools/graph-describe.test.ts` pins
that: the factory is untouched after registration and after a query, and called exactly once across
two index runs.

## What a result costs the model

| Script | Returned | ≈ tokens |
|---|---|---|
| Count paths under `/security` answering DELETE | `85`, 65 characters of payload | ~16 |
| Count `Edm.DateTimeOffset` properties across all types | `1482` | ~16 |
| Count paths needing `ConsistencyLevel` | `443` | ~16 |
| 50 path names | 3,211 characters | ~800 |

This is the point of the mode. The same three answers through `query` would be impossible — a
search cannot phrase "which paths accept DELETE under `/security`" — and returning the index for the
model to filter would cost about 900,000 tokens. The script filters inside the isolate and what
comes back is a number.

A script that returns too much is capped at 40,000 characters and flagged `truncated`, the same way
a run's result is, with a note telling the model to count or filter inside the script instead.

## What it is not allowed to do

Proven in `test/transport/stdio/index-run.test.ts` against the real runtime, with the sandbox the
shipped server actually builds:

| Attempt | What happens |
|---|---|
| `fetch("https://graph.local/get")` — the binding host | throws, *not permitted to access the internet* |
| `fetch("https://example.com")` | same |
| `fetch("http://127.0.0.1:1/")` | same |
| `import("node:fs")` then `readFileSync` | throws, *No such module "node:fs"* |
| `process.env.HOME` | throws, *ReferenceError: process is not defined* |
| `require("node:os")` | throws, *ReferenceError: require is not defined* |
| `env.GRAPH` | throws, *ReferenceError: env is not defined* |

The refusal comes from `workerd`, not from a handler saying no. A sandbox built without the Graph
service binding has `globalOutbound: null`, so there is nothing for a `fetch` to reach and no
argument to `run` that can turn it back on.

## Audit

One line per index run, written before the script starts so a script that wedges the runtime is
still recorded:

```json
{"ts":"2026-09-16T19:13:00.756Z","tool":"graph_describe","scriptHash":"57067f9d…","note":"index run start"}
```

No tenant, no principal, and none of the fields a Graph call fills, because an index run reads a
local file and makes no Graph call.
