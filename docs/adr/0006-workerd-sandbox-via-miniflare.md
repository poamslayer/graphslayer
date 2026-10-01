# The local sandbox is Cloudflare's workerd runtime, driven through Miniflare

Model-written scripts run in a fresh V8 isolate created by the Worker Loader inside `workerd`, Cloudflare's open source Workers runtime. The server drives it through Miniflare, the Node library that starts and configures `workerd`. The isolate's only network path is a service binding that resolves to a Node function in our process, so the script's Graph calls land in our Graph client and the token never enters the isolate. We chose this over QuickJS compiled to WebAssembly because the hosted version will run on Cloudflare Workers with the same Worker Loader, so one sandbox implementation serves both, and because the Cloudflare reference server uses this exact mechanism.

## Considered options

- QuickJS in WebAssembly. One megabyte, no native binary, but a second sandbox implementation the hosted version could not share.
- A V8 isolate package for Node. Rejected for its sandbox-escape history.

## Consequences

- The install is about 170 MB on disk, 109 MB of it the `workerd` binary for the platform. The shipped Graph index adds 3.6 MB unpacked and about 228 kB to the published tarball, taking the package itself from 26.6 kB packed and 106.8 kB unpacked to 255.1 kB and 3.7 MB. Against the 170 MB that is roughly 2%.
- The sandbox caps what the Graph index can be. `workerd` refuses a dynamic worker whose module source exceeds `MAX_DYNAMIC_WORKER_CODE_SIZE`, a constant compiled into the binary at 64 MiB, so the same limit governs the hosted transport. Measured usable budget is 63 MB placed as an object literal and 57 MB through `JSON.parse`. The shipped index is held under 32 MB by a test.
- Local `workerd` does not enforce CPU or memory limits. A script with an infinite loop wedges the runtime. The server enforces a deadline from the Node side, and when a run exceeds it the server disposes the Miniflare instance and creates a new one, which takes about 30 ms. Result size and item counts are capped in the Graph client, not in the isolate.
- Concurrency inside a script is allowed. Several Graph calls can be in flight at once.
- The hosted version needs Cloudflare's Dynamic Workers beta in production, which is a sign-up as of September 2026.
