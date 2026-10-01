# The sandbox is read-only and writes go through a separate tool

Code mode normally exposes everything through one script tool. We split it: the script binding has no write methods at all, and every write goes through `graph_write`, a separate tool annotated as destructive. A client can gate or prompt on that tool by name, and data returned from a tenant cannot trick the model into a mutation from inside a run, because there is nothing in the sandbox that can mutate.

## Considered options

- Writes inside the script under a policy check. Best composition, but the client sees one tool and cannot tell a read script from a delete script. This is what Cloudflare's own production server does: its `execute` tool can "read, create, update, or delete", and the only gate is the permission set the person chose on the consent screen. We read that code before deciding (see `docs/research/cloudflare-mcp-code-mode-reference.md`). Their gate is per connection; ours is per call, and a prompt injection in tenant data cannot reach a write in our model.
- Both paths. Two enforcement points to keep consistent, for a benefit we could not name.

## Consequences

A read-then-write task takes two tool calls, a run and then a write, instead of one script.

> Superseded by ADR-0017 (2026-10-01): `execute` writes through `graph.request`, and `graph_write` is gone.
