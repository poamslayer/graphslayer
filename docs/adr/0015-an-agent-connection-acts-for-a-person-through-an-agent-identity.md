# An agent connection acts for a person through an agent identity

A third connection kind, `agent`, sits beside delegated and app-only. A person signs in, and an Entra Agent ID agent identity calls Graph on their behalf. The token Graph receives names the person as the subject (`upn`, `oid`) and the agent identity as the client (`appid`). It also names the agent's blueprint in `xms_par_app_azp`. So Microsoft's own sign-in and activity logs can tell an agent's call from the person's own. slaystack asked for this (#72) so that a change records both who asked for it and which agent made it, while a person still confirms every write.

## How the token is issued

Entra issues it in three hops, measured live on 2026-09-30 against the POAMslayer tenant with MSAL Node 6.0.1 before any code was written:

1. **The person's token for the blueprint.** The shared Graph Command Line Tools public client (ADR-0003) asks for `api://<blueprintId>/access_agent`. The token comes back with `aud` set to the blueprint's appId and `ver` 2.0, which is what the next exchange requires. No manifest change and no extra client registration was needed. After the first sign-in it comes silently from the same persisted cache as delegated connections.
2. **The exchange token.** The blueprint, using its certificate, asks for `api://AzureADTokenExchange/.default` by client credentials with `fmi_path` set to the agent's appId (`fmiPath` in MSAL). The token's `sub` ends in the agent's appId.
3. **The Graph token.** The agent identity has no credential of its own. It presents the exchange token as its client assertion and runs on-behalf-of with the person's token, asking for `.default`. The `scp` it gets is the set of delegated scopes granted to the blueprint and marked inheritable.

## Decisions

- **Added from the terminal, not from a tool.** The blueprint's certificate password is a credential, so ADR-0007 applies as it does for app-only: `ms-graph-mcp connect --agent` prompts for it and stores it in the keychain under `appOnlySecretAccount(tenantId, blueprintId)`. The connection record holds only the ids, the certificate path and its thumbprint.
- **The mode is explicit.** As for app-only, no scope template implies one, so `--mode` is required. ADR-0012 is unchanged: `graph_write` checks the mode.
- **The audit line gains `actor`.** For an agent connection, `principal` is the person and `actor` is `agent:<agentId>`. Folding the agent into `principal` would split one person's calls across two names, and a search by person is the question the log is most often asked.
- **Commercial cloud only.** The token exchange audience and Entra Agent ID availability are not the same in GCC High, and nothing has been measured there. `signInAgent` refuses other clouds rather than guessing.
- **No #73 refresh.** An agent's scopes come from the blueprint's grant, not from a consent the person gives, so the case of consent granted outside the server does not arise. `refreshGraphToken` returns nothing for this kind.

## Consequences

- Entra's own sign-in log records the agent's calls as non-interactive user sign-ins. Each one shows the person as `userPrincipalName`, the agent identity as the app, and an `agent` object with `agentType` `agenticAppInstance` and `parentAppId` set to the blueprint. Measured 2026-10-01 with `GET /beta/auditLogs/signIns`. They only appear when the filter includes `signInEventTypes/any(t: t eq 'nonInteractiveUser')`, because the default query returns interactive sign-ins only.

- An agent identity can never hold `Application.ReadWrite.All`, `RoleManagement.ReadWrite.All`, `User.ReadWrite.All` or `Directory.AccessAsUser.All`, even with admin consent. A write that needs one of those cannot be made through an agent connection. Entra refuses the grant, so the server has nothing to enforce.
- An agent connection shares the person's cached sign-in with their delegated connections. `connection_remove` therefore keeps the cached account while another connection still uses it. Before this, removing any one connection signed every connection on that account out.
- Setting up the blueprint, its certificate, its exposed `access_agent` scope, its Graph grant and the inheritable permissions is done in Entra, once, outside this server.

> Superseded in part by ADR-0016 (2026-10-01): the server keeps no local audit log, so where this record mentions audit lines, Microsoft's own logs are the record now.

> Superseded in part by ADR-0017 (2026-10-01): a person no longer confirms each write, and `graph_write` is now `execute`.
