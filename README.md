# graphslayer

An MCP server for Microsoft Graph, built the way Cloudflare's MCP server is: three tools, `docs`, `search` and `execute`. The model writes a short script that runs in a sandbox against a typed Graph client, so only the result it asked for comes back. A script can write through a connection that was added read-write.

## Requirements

| | |
|---|---|
| Node.js | 22 or newer. Check with `node --version`. |
| Disk | About 310 MB for a source install. Most of it is the `workerd` binary for your platform at 109 MB, plus the build tooling a clone needs and a published install would not. |

macOS, Linux and Windows are all supported on x64 and arm64. Both native dependencies resolve a
per-platform binary at install time, so there is nothing to compile.

**Linux needs one thing the other two do not.** Sign-ins are stored through the Secret Service
API over D-Bus. A desktop install already provides it; a minimal or headless machine does not,
and storing a sign-in fails without it:

```bash
sudo apt install gnome-keyring libsecret-1-0   # Debian, Ubuntu
sudo dnf install gnome-keyring libsecret       # Fedora, RHEL
```

Over SSH there is no session bus to talk to, so run the server under one: `dbus-run-session -- <command>`.

## Install

It is on npm, so your MCP client can start it with `npx`. Add this to your client's config:

```json
{
  "mcpServers": {
    "graphslayer": {
      "command": "npx",
      "args": ["-y", "graphslayer"]
    }
  }
}
```

Claude Code takes the same thing as one command:

```bash
claude mcp add graphslayer -- npx -y graphslayer
```

Where the config file lives:

| Client | Location |
|---|---|
| Claude Desktop, macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop, Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop, Linux | `~/.config/Claude/claude_desktop_config.json` |
| VS Code | `.vscode/mcp.json` in the workspace |

Restart the client after editing the file. The first start downloads about 170 MB, most of it the
`workerd` runtime for your platform.

### From source

To work on the server itself, clone it and point your client at the build:

```bash
git clone https://github.com/poamslayer/graphslayer.git
cd graphslayer
npm install
npm run build
```

Then use `"command": "node"` with `"args": ["/absolute/path/to/graphslayer/dist/cli/main.js"]`.
On Windows, escape the backslashes in the path. A server started from a stale `dist/` keeps running
the old code, because Node does not reload it, so rebuild and then reconnect, in that order.

## First sign-in

Ask the model to add a connection, or run this in a terminal from the clone:

```bash
npx -y graphslayer connect --alias contoso
```

A browser window opens. Sign in with a work account and approve the requested read permissions.
The sign-in is cached in your operating system keychain — Keychain on macOS, Credential Manager
on Windows, the Secret Service on Linux. Tokens and secrets never pass through the model.

## App-only connections

An app-only connection runs as an application rather than as a person, with the permissions an
administrator granted your own app registration. Adding one is a terminal command and cannot be
done from inside a chat, because no tool argument ever carries a credential.

```bash
npx -y graphslayer connect --app-only --tenant <tenant-id> --client-id <your-app-id> --mode read
```

The command prompts for the client secret. Nothing is echoed, there is no flag for it, and it goes
straight to your operating system keychain; the connections file records only the tenant, the
client id and the mode. For a certificate instead of a secret, pass `--cert <path>` to a PEM
holding the certificate and its encrypted private key, and the prompt asks for the password that
decrypts the key.

Three flags are required and have no defaults:

| Flag | Why it is required |
|---|---|
| `--tenant <id>` | Client credentials are issued per tenant. There is no organizations authority for this flow. |
| `--client-id <id>` | The default Microsoft Graph Command Line Tools app is a public client and cannot hold a credential, so app-only needs your own registration. |
| `--mode read\|write` | App-only gets no scope template, so the mode is the only thing deciding whether `execute` may write through the connection. |

`--template` and `--scopes` are refused with `--app-only`. The client credentials flow must
request `.default`, so the connection takes whatever an administrator granted and a named ask
would not change what the token carries.

Removing an app-only connection with `connection_remove` clears its keychain credential as well as
its record.

## Agent connections

An agent connection has an Entra Agent ID agent identity call Graph on your behalf. Graph sees
you as the user and the agent identity as the client, so Microsoft's sign-in and activity logs
can tell the agent's calls from your own. Commercial cloud only for now. ADR-0015 explains the token flow.

Set this up in Entra first, once:
- An agent identity blueprint with a certificate.
- An exposed `access_agent` scope on the blueprint.
- The delegated Graph scopes granted to the blueprint and marked inheritable.
- An agent identity created from the blueprint.

Microsoft Learn's "Create an agent identity blueprint" walks through each step. Agent identities
can never hold `Application.ReadWrite.All`, `RoleManagement.ReadWrite.All`, `User.ReadWrite.All`
or `Directory.AccessAsUser.All`.

```bash
npx -y graphslayer connect --agent --tenant <tenant-id> --blueprint-id <blueprint-app-id> \
  --agent-id <agent-app-id> --cert <path-to-blueprint.pem> --mode read --alias agent
```

The command prompts for the password that decrypts the blueprint's private key, and that password
goes to your operating system keychain. Then a browser window opens for you to sign in. `--tenant`,
`--blueprint-id`, `--agent-id` and `--mode` are required. `--template` and `--scopes` are refused,
because the agent's scopes are the ones its blueprint was granted.

Removing an agent connection clears the blueprint credential from the keychain. Your cached
sign-in stays while another connection still uses it.

## National clouds

GCC High is supported. A connection names the cloud it lives in, once, when you add it, and every
call made through it follows — the sign-in authority, the Graph host, and the scope a client
credential asks for. One server can hold a commercial tenant and a GCC High tenant at the same
time.

| Cloud | Sign-in | Graph |
|---|---|---|
| `commercial` (default) | `login.microsoftonline.com` | `graph.microsoft.com` |
| `usgov-high` | `login.microsoftonline.us` | `graph.microsoft.us` |

Pass it when you add the connection:

```bash
npx -y graphslayer connect --cloud usgov-high --alias agency
npx -y graphslayer connect --app-only --cloud usgov-high --tenant <tenant-id> --client-id <your-app-id> --mode read
```

From a chat, `connection_add` takes the same `cloud` argument. `execute` does
not: it reads the cloud off the connection you name, so there is no way to point a Gov connection
at a commercial host by mistake.

Leaving `--cloud` off means commercial, which is also what a connection stored before this existed
means. Nothing needs rewriting.

**Sign-in usually requires a compliant device.** GCC High tenants commonly enforce Conditional
Access device compliance, so the browser sign-in has to happen on a machine enrolled in that
tenant. When it does not, sign-in fails at the policy, not in this server — it is worth ruling that
in before reading anything else as a bug.

### What `search` knows about a Gov tenant

`search` takes a `cloud` argument of its own, because it answers from the shipped index
without a connection to read one off:

```
search { code: "return Object.keys(index.paths).filter(p => p.includes('conditionalAccess'))", cloud: "usgov-high" }
```

A Gov tenant does not have every path the commercial metadata describes, so the index build
derives a removal list from the live Gov metadata and the loader subtracts it. On `usgov-high`,
2,739 of the 11,546 v1.0 paths are gone — entity sets, entity types, and the actions and functions
a Gov tenant cannot invoke — so search stops offering paths that would only ever 404.

Two limits are worth knowing, both from ADR-0014. Only one of the five sources the index is built
from publishes a Gov equivalent, so **path shape is Gov-correct while least-privileged scopes are
not**. The `search` description says so, so the model does not treat the commercial scopes as verified. The
`ConsistencyLevel` decision is inherited from commercial for the same reason.

## How scripts run

Scripts run in a fresh V8 isolate inside Cloudflare's open source `workerd` runtime, which the server starts on your machine through Miniflare. The isolate has no filesystem and no network. Its only way out is a call back into this server, which holds your token and makes the Graph request. The install is about 170 MB because it includes the `workerd` binary for your platform.

## Tools

The server has three tools, copied from Cloudflare's MCP server (ADR-0017), plus the connection tools.

- `connections_list`, `connection_add`, `connection_remove`
- `docs`: search Microsoft Learn. It returns the most relevant passages, each with its page title
  and link, from Microsoft's public Learn MCP server. Use it to answer how something works before
  reading a tenant.
- `search`: run a script over the shipped Graph index, which holds every path, method, entity
  property, enum, and the permissions each call needs. It needs no tenant and no connection, and
  the script runs in a sandbox with no network at all.

  ```js
  // Least-privileged delegated scope to list conditional access policies
  return index.paths["/identity/conditionalAccess/policies"]?.scopes?.get?.delegated;
  ```
- `execute`: run a script against one tenant. It reads, and on a connection added read-write it
  writes. Example the model might write:

```js
const p = await graph.all("/identity/conditionalAccess/policies", { select: ["id", "displayName", "state"] });
return p.filter(x => x.state === "enabled").map(x => x.displayName);
```

  Writes go through `graph.request({ method, path, body })`, which returns `{ status, body }`:

```js
return await graph.request({ method: "PATCH", path: "/users/{id}", body: { accountEnabled: false } });
```

  A connection added in read mode refuses every method but GET before anything is sent. That is
  the only limit on writes, the same way Cloudflare's only limit is the permission set chosen on
  its consent screen. There is no preview and no confirm step. A write is resent only when Graph
  answers 429, because a 503 or 504 may arrive after the write was applied.

  Reads are shaped so a page costs what it needs to. A collection read with no `select` sends a
  small default set of fields for the directory resources, which takes a page of a hundred groups
  from about 223 kB to about 27 kB. Pass `select: ["*"]` for the whole object. `search` shows a
  path's default. No page size is sent unless the script asks for one, because some collections
  reject one outright.

## Shutting down

The server disposes the `workerd` runtime before exiting when your MCP client disconnects, when
it is sent SIGINT or SIGTERM, or when the client simply closes the connection and goes away. The
last of those is worth naming, because the MCP SDK's stdio transport does not report end of input
on its own, so a server without that handling stays running for the rest of your session holding
a runtime that measures over a hundred megabytes.

`kill -9` is the one case nothing can cover: no handler runs, and the runtime is a separate
process that outlives its parent. If you kill the server that way, check for a stray process:

```bash
pgrep -fl workerd
```

## Configuration

| Variable | Meaning |
|---|---|
| `GRAPHSLAYER_HOME` | Directory for connections and the token cache. Default `~/.graphslayer`. |
| `GRAPHSLAYER_CLIENT_ID` | Your own Entra app registration (public client). Default is the Microsoft Graph Command Line Tools app. |
| `GRAPHSLAYER_NO_TOKEN_CACHE` | Set to `1` to keep tokens in memory only. |

## Where calls are recorded

The server keeps no log of its own. Microsoft 365 records the calls, in the tenant, where an
administrator already looks. ADR-0016 explains why.

| Record | What it shows | What it needs |
|---|---|---|
| Entra sign-in log | Each sign-in, and for an agent connection the agent and the person | Every tenant |
| Entra and workload audit logs | Each change: what changed, who made it, and when | Every tenant |
| Microsoft Graph activity logs | Every Graph request, reads included | Entra ID P1 or P2, and a diagnostic setting that sends the logs to Log Analytics, Storage or Event Hubs |

Every Graph request this server makes carries `User-Agent: graphslayer/<version>`. On a
delegated connection the client id is shared with Graph PowerShell, so the User-Agent is how you
tell the server's calls apart. In Log Analytics:

```kusto
MicrosoftGraphActivityLogs
| where UserAgent startswith "graphslayer/"
| project TimeGenerated, UserId, AppId, RequestMethod, RequestUri, ResponseStatusCode, Scopes
```

An agent connection's calls appear in the sign-in log as non-interactive sign-ins. The default
query hides them, so ask for them by type:

```
GET /beta/auditLogs/signIns?$filter=signInEventTypes/any(t: t eq 'nonInteractiveUser') and appId eq '<agent-app-id>'
```

A write the server refused, because the connection is in read mode, never reaches Graph, so no
Microsoft log records it. The model sees the refusal in the tool's answer.

Versions before ADR-0016 wrote to `~/.graphslayer/audit/`. Nothing writes there now, and you can
delete that folder.

## Development

```bash
npm install
npm test
npm run build
node dist/cli/main.js --help
```

## Release

The package ships a **Graph index**, `data/graph-index.json`: an offline catalogue of Graph
paths, entity types and their properties, and least privileged scopes, built from Microsoft's
published metadata. Regenerate it as part of every release, before publishing:

```bash
npm run build:index -- --refresh    # re-download Microsoft's metadata, then rebuild
npm test                            # asserts the index is under 32 MB and loads in an isolate
```

`--refresh` matters: without it the build reuses whatever metadata is cached, which is right
while iterating and wrong for a release. Read the report the build prints. If it lists a path
as unclassified, or a type name it could not resolve, Microsoft has changed a shape — that is
a build to look at rather than a build to ship. It needs python3 with PyYAML;
`scripts/build-index/README.md` has the prerequisites and the measured figures.
