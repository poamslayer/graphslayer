# graph_describe reuses the one sandbox, with the network fixed at construction

`graph_describe` can run a script against the Graph index, which is a second entry point into the sandbox with different rules: the index is a constant inside the isolate, there is no connection, and there must be no network at all. Rather than build a second sandbox for it, we keep one `Sandbox` interface and one Miniflare driver and fix the network when a sandbox is constructed rather than per run. The host worker reads `globalOutbound: env.GRAPH ?? null`, so a sandbox built without the Graph service binding has no network and no per-run argument can turn it on. `graph_run` is handed a sandbox built with that service binding; `graph_describe` is handed one built with the index and without it.

## Considered options

- **Per-run outbound.** One sandbox instance and one `workerd` process, with the handler and the index passed to `run()`. Rejected because the no-network guarantee moves to the call site: nothing in the type stops a later caller from passing both.
- **A second, narrower interface for index runs.** The strongest claim, because a separate host worker can write `globalOutbound: null` as a literal with no service bindings to omit. Rejected for its cost: two host worker sources to keep in step, a second driver for the guard test in `test/core/architecture.test.ts` to cover, and both to port when the Worker transport lands.
- **Reuse unchanged, with a handler that refuses every call.** Zero new code, and the prototype measured it working at 368 ms against 141 ms for a purpose-built worker. Rejected because the isolate still carries `globalOutbound: env.GRAPH`, so a script can still reach the binding host and only a Node-side handler refuses it. "No network at all" would become "the handler says no", a weaker claim than ADR-0006 makes for the run sandbox.

## Consequences

- The default inverts, and that is the point. `globalOutbound: env.GRAPH` is an expression that resolves to `undefined` when the service binding is absent, and the Worker Loader reads an undefined outbound as "inherit the parent", so omitting the service binding would have given the isolate *more* network rather than none. With `?? null` the network is a service binding, and no service binding means no network. A sandbox test asserts a script in the index sandbox cannot reach any host.
- Two sandboxes means two Miniflare instances and two `workerd` processes. Both start lazily, so the index sandbox costs nothing until the first index run.
- An index run pays the index parse every time, because the Worker Loader caches by worker id and every run has its own id. The prototype measured 141 ms for a 15.7 MB v1.0 index in a worker of this shape.
- The interface gains one optional argument rather than a second type, so `test/core/architecture.test.ts` still guards a single driver.

> Tool names changed in ADR-0017 (2026-10-01): `graph_describe` is now `search`, and `graph_run` and `graph_write` are now `execute`.
