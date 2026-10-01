# graphslayer

An MCP server that lets an AI agent read from and write to Microsoft Graph across one or more Microsoft 365 tenants. It has three tools, copied from Cloudflare's MCP server: `docs` searches Microsoft Learn, `search` runs a script over the Graph index, and `execute` runs a script against a tenant. A script both reads and writes, and a connection can write only when it was added read-write.

## Language

### Identity and tenants

**Cloud**:
The Microsoft cloud a tenant lives in, which fixes both the Graph endpoint and the sign-in authority. Commercial and GCC High ship. GCC Moderate is commercial, and tokens are not interchangeable between clouds.
_Avoid_: Environment (means dev and staging elsewhere), region (an Azure region is a different axis), tenant type, sovereign cloud

**Tenant**:
One Microsoft Entra ID directory, identified by its tenant id and living in exactly one cloud. Every Graph call runs against exactly one tenant.
_Avoid_: Directory, org, customer (a customer may own several tenants)

**Connection**:
One signed-in identity for one tenant, stored by the server, carrying the cloud that tenant is in. A connection is either delegated or app-only. It is a stored record, never a network connection.
_Avoid_: Account, session, login, profile, HTTP connection

**Alias**:
The short name a person gives a connection. A tool's tenant argument accepts an alias or a tenant id and resolves it to a connection.
_Avoid_: Name, label, nickname

**Delegated connection**:
A connection where a person signed in through the browser, so calls run as that person with the permissions they consented to.
_Avoid_: User connection, interactive connection

**App-only connection**:
A connection backed by an application credential, so calls run as the application with the permissions an administrator granted it.
_Avoid_: Service principal connection, daemon, client credentials connection

**Agent connection**:
A connection where a person signed in and an agent identity calls Graph on their behalf. The token names the person as the subject and the agent identity as the client. Added from the terminal, because the blueprint's credential must not pass through a chat. ADR-0015.
_Avoid_: Agent user, bot connection

**Agent identity**:
The Entra Agent ID identity Graph sees as the client of an agent connection. It holds no credential of its own and gets its scopes from its blueprint.
_Avoid_: Agent app, agent service principal

**Blueprint**:
The Entra Agent ID application an agent identity is created from. It holds the certificate, exposes the `access_agent` scope a person's token is issued for, and holds the delegated Graph grant its agent identities inherit.
_Avoid_: Template, parent app

**Principal**:
The identity a call runs as: the signed-in person for a delegated or agent connection, or the application for an app-only connection.
_Avoid_: User, caller

**Actor**:
Who made a call for the principal, when that is not the principal itself. Only an agent connection has one: the token names the agent identity as its client, and Entra's sign-in log shows the agent beside the person.
_Avoid_: Caller, agent user

**Scope**:
One Graph permission name, such as `User.Read.All`.
_Avoid_: Permission (ambiguous with Entra role permissions), grant

**Granted scopes**:
The scopes a tenant has consented for the client id, which is what a token carries. They can be wider than the scopes the server asked for, because consent belongs to the application rather than to this server. A connection records them when it is added, and the record is updated when a refreshed token carries a scope that someone granted later, outside the server.
_Avoid_: Permissions, consented permissions

**Requested scopes**:
The scopes a delegated sign-in asked for, either named explicitly or taken from a scope template. They are what the consent screen showed, so they are what the person agreed to. Kept on the connection beside its granted scopes, because the two routinely differ.
_Avoid_: Consented scopes, asked scopes

**Inherited scopes**:
Granted scopes that the sign-in did not request, leaving out the sign-in scopes (`openid`, `profile`, `email`, `offline_access`) that every sign-in adds. They come from consent the client id already held in the tenant, usually tenant-wide consent collected by another tool that shares it. Adding a connection reports them, rather than refusing the connection.
_Avoid_: Extra scopes, leaked scopes, over-grant

**Scope template**:
A named set of scopes a person chooses when adding a connection. Two ship: read only, and read write. Membership is decided by reading each scope's name, not by a hand-written list.
_Avoid_: Preset, profile, role, policy, permission set

**Connection mode**:
Whether a connection may write, fixed when it is added and checked before every write. It is not the same as kind: kind says delegated, app-only or agent, mode says read or read-write. It exists because a connection's token routinely carries more than the scopes it asked for.
_Avoid_: Kind, level, permission, role

**Unclassified scope**:
A scope whose name does not say whether it reads or writes, such as `Directory.AccessAsUser.All`. Every one is treated as a write, so a misreading keeps it out of the read only template rather than smuggling it in.
_Avoid_: Unknown scope, edge case, exception

### Scripts

**Script**:
JavaScript the agent writes to read from or write to Graph. It is the body of an async function and returns the value the agent wants back.
_Avoid_: Code, query, program

**Run**:
One execution of one script against one connection.
_Avoid_: Execution, job, invocation

**Index run**:
One execution of a script against the Graph index, with no connection and no tenant data. The search tool runs one for every question about Graph itself.
_Avoid_: Spec run, offline run, describe run

**Sandbox**:
The isolated environment a script executes in. Whether it can reach Graph at all is fixed when the sandbox is built, not by the script that runs in it.
_Avoid_: VM, container, isolate

**Binding**:
The Graph object a script can call from inside the sandbox. It reads, and through `request` it writes when the connection's mode allows.
_Avoid_: Client, SDK, API

**Call**:
One Graph request made through the binding during a run. Each call is counted against the run's cap and listed in its result.
_Avoid_: Request, hit, fetch

**Page**:
One batch of items from a Graph collection, plus a cursor when more items exist.
_Avoid_: Chunk, result set

**Cursor**:
An opaque token the binding returns with a page and accepts to fetch the next page.
_Avoid_: Skip token, next link, continuation

**Result**:
The value a script returns, after the server caps its size.
_Avoid_: Output, response, data

**Graph index**:
The server's offline catalogue of Graph paths, entity properties, default field selections, and least-privileged scopes. The search tool runs scripts over it.
_Avoid_: Metadata, schema, OpenAPI

**Task tool**:
A tool named for one assessment question, such as conditional access policies missing a break glass exclusion. It runs a fixed read against the Graph client and returns typed output.
_Avoid_: Preset, recipe, macro

### Writing

**Write**:
A Graph request that changes tenant state. A script makes one through `graph.request` during a run. The connection's mode must be read-write, and Graph applies it only where the granted scopes allow. There is no preview and no confirm step. ADR-0017.
_Avoid_: Mutation, update, change, action

### Records

**Native record**:
Where Microsoft 365 records what the server did: the sign-in log, the Entra and workload audit logs, and, with P1 and a diagnostic setting, Microsoft Graph activity logs. The server keeps no log of its own. ADR-0016.
_Avoid_: Audit log, audit event, local log
