# No local audit log: Microsoft's logs are the record

The server used to append every call, run start, write and connection change to `~/.ms-graph-mcp/audit/YYYY-MM-DD.ndjson`. It does not anymore. Microsoft 365 already records what the server does, in the tenant, where an administrator looks. The rule for this project is to keep nothing locally that Microsoft 365 records natively (#74). A log on one laptop is also a weaker record: nobody else can read it, and anyone who can edit that laptop's files can edit the log.

Cloudflare's reference server (`cloudflare/mcp`, read 2026-10-01) is the model here too, as it was for ADR-0012. It keeps no per-call audit log. It sends only usage counters (tool name, user id, error code) to its analytics store, and it leaves the record of what changed to Cloudflare's own account audit logs.

## What Microsoft records

- **The Entra sign-in log**, in every tenant. An agent connection's calls appear as non-interactive user sign-ins. Each one names the person, the agent identity, and the blueprint as `parentAppId` (ADR-0015). They only appear when the query asks for `signInEventTypes` `nonInteractiveUser`.
- **The Entra and workload audit logs**, in every tenant: the directory audit log, the Intune audit log, and Purview. They record each change: what changed, who made it, and when.
- **Microsoft Graph activity logs** record every request Graph receives, reads included, with the user, the app, the method, the URI, the status and the User-Agent. They need Entra ID P1 or P2, an Azure subscription, and a diagnostic setting that sends them to Log Analytics, Storage or Event Hubs. Events arrive within 30 minutes, and sometimes up to 2 hours. They are available in commercial and in US Government L4 and L5, so a GCC High tenant can prove a read stayed in its boundary. ADR-0013 gave that reason for recording the cloud.

## The User-Agent

On a delegated connection the client id is the shared Graph Command Line Tools app (ADR-0003). Graph PowerShell and the Graph CLI use the same app, so the client id alone cannot tell this server's calls from a person's PowerShell session. Every Graph request therefore carries `User-Agent: ms-graph-mcp/<version>`. The client sets the header after the caller's headers, so no code path can drop it. An agent connection is identified by its own appId as well.

## What is given up

- **Reads in a tenant without P1, or without the diagnostic setting.** Microsoft records no reads there, and now neither do we. Such a tenant still has the sign-in log and the audit logs of every change.
- **Dry runs and refused writes.** They never reach Graph, so no Microsoft log can see them. The model sees both in the tool's answer.
- **Our own before-and-after of a write.** The confirming call still returns the preview to the model. The record of the change itself is the workload's audit log.
- **The `actor` audit field from ADR-0015** goes with the log. The token and the sign-in log still carry the agent.

## Consequences

- `AuditLogger`, `auditDir`, and the `audit` dependency of every tool and of the CLI are gone.
- Files already written under `~/.ms-graph-mcp/audit/` are left where they are. The README says they can be deleted.
- ADR-0003, ADR-0013 and ADR-0015 mention audit lines. Where they do, this ADR replaces that part.
