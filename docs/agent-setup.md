# Set up an agent connection

An agent connection lets an AI agent call Graph for you through an Entra Agent ID agent identity.
Graph sees you as the user and the agent identity as the app, so Microsoft's sign-in log shows
which calls the agent made. ADR-0015 explains how the token is issued.

This guide creates the Entra objects the connection needs, then adds the connection. You do the
Entra part once per tenant. It works in the commercial cloud only. graphslayer refuses an agent
connection in GCC High.

## What you create

| Object | What it is for | What graphslayer needs from it |
|---|---|---|
| Agent identity blueprint | The app the agent identity is made from. It holds the certificate and the Graph permissions. | Its app ID, as `--blueprint-id` |
| Blueprint principal | The blueprint's service principal in your tenant. You grant Graph permissions to it. | Nothing |
| Certificate | The blueprint's credential. | A PEM file, as `--cert` |
| `access_agent` scope | The scope Entra issues your sign-in token for. The blueprint exchanges that token for the agent's Graph token. | Nothing |
| Agent identity | The app Graph sees on each call. It has no credential and no permissions of its own. | Its app ID, as `--agent-id` |

The steps below match the blueprint in the POAMslayer tenant, read on 2026-10-02.

## Before you start

You need these Entra roles:

- Agent ID Administrator, to create the blueprint and add its certificate.
- Cloud Application Administrator or Application Administrator, to grant Graph
  permissions to the blueprint.

The requests below are Microsoft Graph calls. You can send them from Graph Explorer, or from
Microsoft Graph PowerShell 7 with `Invoke-MgGraphRequest`. To get every scope the steps use in
one PowerShell sign-in:

```powershell
Connect-MgGraph -TenantId <tenant-id> -Scopes `
  "AgentIdentityBlueprint.Create", "AgentIdentityBlueprint.AddRemoveCreds.All", `
  "AgentIdentityBlueprint.UpdateAuthProperties.All", "AgentIdentityBlueprint.ReadWrite.All", `
  "AgentIdentityBlueprintPrincipal.Create", "AgentIdentity.Create.All", `
  "DelegatedPermissionGrant.ReadWrite.All", "Application.Read.All", "User.Read"
```

Every request that sends an `@odata.type` also needs the header `OData-Version: 4.0`.

## 1. Create the blueprint

A blueprint needs a sponsor, the person accountable for the agent. Use your own user ID for the
sponsor and the owner.

```http
POST https://graph.microsoft.com/v1.0/applications
OData-Version: 4.0
Content-Type: application/json

{
  "@odata.type": "Microsoft.Graph.AgentIdentityBlueprint",
  "displayName": "graphslayer Blueprint",
  "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<your-user-id>"],
  "owners@odata.bind": ["https://graph.microsoft.com/v1.0/users/<your-user-id>"]
}
```

Copy `appId` and `id` from the response. The steps below call the app ID `<blueprint-app-id>`. In
the POAMslayer tenant, `id` and `appId` were the same value, so the `/applications/...` paths below
use `<blueprint-app-id>` too. If yours differ, use `id` in those paths.

## 2. Create the blueprint principal

```http
POST https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal
OData-Version: 4.0
Content-Type: application/json

{ "appId": "<blueprint-app-id>" }
```

Copy `id` from the response. The steps below call it `<blueprint-principal-id>`.

## 3. Add a certificate

graphslayer reads one PEM file that holds the certificate and its private key. The key must be
encrypted with a password. graphslayer asks for that password when you connect and keeps it in
your keychain.

Make the certificate and the combined file:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 \
  -subj "/CN=graphslayer blueprint" -keyout key.pem -out cert.pem
cat cert.pem key.pem > blueprint.pem
```

`openssl` asks for a password and encrypts `key.pem` with it. Keep `blueprint.pem` somewhere
private. Delete `key.pem` once `blueprint.pem` exists.

Then upload `cert.pem` to the blueprint. It holds only the public certificate. In the Microsoft
Entra admin center, open **Entra ID** > **Agents** > **Agent blueprints**, select your blueprint,
and add the certificate under its credentials. Or follow Microsoft's
[Add a certificate credential](https://learn.microsoft.com/graph/api/application-addkey?tabs=http#example-3-add-a-certificate-credential-to-an-application)
example against `<blueprint-app-id>`.

A client secret also works. Leave out `--cert` in step 8 and graphslayer asks for the secret
instead. Microsoft recommends a certificate over a secret.

## 4. Expose the `access_agent` scope

graphslayer signs you in for `api://<blueprint-app-id>/access_agent`, so the blueprint must
expose that scope. Use a new GUID for `id`. In PowerShell, `[guid]::NewGuid()` makes one.

```http
PATCH https://graph.microsoft.com/v1.0/applications/<blueprint-app-id>
OData-Version: 4.0
Content-Type: application/json

{
  "identifierUris": ["api://<blueprint-app-id>"],
  "api": {
    "oauth2PermissionScopes": [{
      "adminConsentDescription": "Allow the application to access the agent on behalf of the signed-in user.",
      "adminConsentDisplayName": "Access agent",
      "id": "<new-guid>",
      "isEnabled": true,
      "type": "User",
      "value": "access_agent"
    }]
  }
}
```

A 204 response means it worked.

## 5. Grant Graph permissions to the blueprint

Grant the delegated Graph scopes the agent should have to the blueprint principal, for all users.
First find the ID of Microsoft Graph's service principal in your tenant:

```http
GET https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'&$select=id
```

Then create the grant. List the scopes separated by spaces. These are the scopes the POAMslayer
blueprint has, all of them read-only:

```http
POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants
Content-Type: application/json

{
  "clientId": "<blueprint-principal-id>",
  "consentType": "AllPrincipals",
  "resourceId": "<graph-service-principal-id>",
  "scope": "User.Read Directory.Read.All Policy.Read.All AuditLog.Read.All DeviceManagementConfiguration.Read.All"
}
```

The agent can only do what both the grant and your own roles allow. Entra never lets an agent
identity hold `Application.ReadWrite.All`, `RoleManagement.ReadWrite.All`, `User.ReadWrite.All` or
`Directory.AccessAsUser.All`, even when the blueprint has them.

Microsoft Learn says a granted scope is inherited only if it is also listed in the blueprint's
`requiredResourceAccess`. The POAMslayer blueprint's `requiredResourceAccess` is empty, and its
agent's tokens still carry every scope in the grant. If yours do not, add the scopes there too.

## 6. Mark the Graph permissions inheritable

A grant on the blueprint reaches its agent identities only if the blueprint marks that resource
inheritable. This marks every granted Graph scope inheritable, and no app roles:

```http
POST https://graph.microsoft.com/v1.0/applications/microsoft.graph.agentIdentityBlueprint/<blueprint-app-id>/inheritablePermissions
OData-Version: 4.0
Content-Type: application/json

{
  "resourceAppId": "00000003-0000-0000-c000-000000000000",
  "inheritableScopes": { "@odata.type": "#microsoft.graph.allAllowedScopes", "kind": "allAllowed" },
  "inheritableRoles": { "@odata.type": "#microsoft.graph.noRoles", "kind": "none" }
}
```

With `allAllowed`, a scope you add to the grant in step 5 later reaches the agent too. Do not
grant permissions to the agent identity itself. It cannot take consent, and Entra answers
`AADSTS82014` if you try.

## 7. Create the agent identity

In the Microsoft Entra admin center, open **Entra ID** > **Agents** > **Agent identities**, select
**New agent identity**, pick your blueprint, and name it. Or send:

```http
POST https://graph.microsoft.com/beta/servicePrincipals/Microsoft.Graph.AgentIdentity
OData-Version: 4.0
Content-Type: application/json

{
  "displayName": "graphslayer Agent",
  "agentIdentityBlueprintId": "<blueprint-app-id>",
  "sponsors@odata.bind": ["https://graph.microsoft.com/v1.0/users/<your-user-id>"]
}
```

Copy `appId` from the response. The next step calls it `<agent-app-id>`.

## 8. Add the connection

```bash
npx -y graphslayer connect --agent --tenant <tenant-id> --blueprint-id <blueprint-app-id> \
  --agent-id <agent-app-id> --cert <path-to-blueprint.pem> --mode read --alias agent
```

It asks for the certificate password, then opens a browser for you to sign in. Use `--mode write`
only if the agent should be able to change things. The mode is graphslayer's limit, and the grant
in step 5 is Entra's limit. A write needs both.

## 9. Check it

Ask your agent to run `connections_list`. The `agent` connection's `scopes` should be the scopes
you granted in step 5, plus `openid`, `profile` and `email`.

The agent's calls appear in the Entra sign-in log as non-interactive sign-ins, with you as the
user and the agent identity as the app. The default sign-in log view hides them. See
[Where calls are recorded](../README.md#where-calls-are-recorded) for the query that shows them.

## If something fails

| Symptom | Cause |
|---|---|
| A scope you granted is missing from `connections_list` | The blueprint does not mark Graph as inheritable, which is step 6. Or the grant is on the agent identity instead of the blueprint principal. If both are right, add the scope to the blueprint's `requiredResourceAccess`. |
| `AADSTS82014` | Something asked for consent on the agent identity. Grant on the blueprint principal instead. |
| `AADSTS7000215` or a certificate error | The blueprint does not have the certificate in `--cert`, or the password was wrong. Run `connect` again. |
| graphslayer refuses the connection for the cloud | Agent connections work in the commercial cloud only. |

## Sources

- [Create an agent identity blueprint](https://learn.microsoft.com/entra/agent-id/create-blueprint)
- [Configure inheritable permissions for agent identity blueprints](https://learn.microsoft.com/entra/agent-id/configure-inheritable-permissions-blueprints)
- [Inheritable permissions and required resource access](https://learn.microsoft.com/entra/agent-id/concept-inheritable-permissions)
- [Create agent identities](https://learn.microsoft.com/entra/agent-id/create-delete-agent-identities)
- [Agent OAuth flows: on behalf of flow](https://learn.microsoft.com/entra/agent-id/agent-on-behalf-of-oauth-flow)
