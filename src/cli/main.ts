#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MsalAuth } from "../core/auth/msal.js";
import { inheritedScopesReport, SCOPE_NAME_RE, type ScopeTemplate } from "../core/auth/scopes.js";
import type { Cloud } from "../core/config.js";
import { cloudOf, modeOf, type ConnectionStore } from "../core/connections/store.js";
import type { ConnectionMode } from "../core/types.js";
import { buildDeps, startStdioServer } from "../transport/stdio/main.js";
import { promptSecret, type PromptIo } from "./prompt.js";

export type CliArgs =
  | { command: "serve" }
  | { command: "help" }
  | { command: "connections" }
  | { command: "connect"; alias?: string; tenantHint?: string; cloud?: Cloud; scopes?: string[]; template?: ScopeTemplate }
  | { command: "connect-app-only"; alias?: string; tenantId: string; clientId: string; mode: ConnectionMode; cloud?: Cloud; certPath?: string }
  | { command: "connect-agent"; alias?: string; tenantId: string; blueprintId: string; agentId: string; mode: ConnectionMode; cloud?: Cloud; certPath?: string };

export const APP_ONLY_NEEDS_TENANT =
  "--app-only needs --tenant <id>. Client credentials are issued per tenant, so there is no organizations authority for this flow.";
export const APP_ONLY_NEEDS_CLIENT_ID =
  "--app-only needs --client-id <id>. The default Microsoft Graph Command Line Tools app is a public client and cannot hold a credential, so an app-only connection must name your own app registration.";
export const APP_ONLY_NEEDS_MODE =
  "--app-only needs --mode read or --mode write. App-only gets no scope template, so the mode is the only thing deciding whether this connection may write.";
export const APP_ONLY_REJECTS_TEMPLATE =
  "--template cannot be combined with --app-only. Client credentials must request .default, so the connection takes whatever permissions an administrator granted the registration and a template would only describe an ask that never happens.";
export const APP_ONLY_REJECTS_SCOPES =
  "--scopes cannot be combined with --app-only, for the same reason as --template: client credentials request .default and named scopes are not part of the flow.";

export const AGENT_NEEDS_TENANT =
  "--agent needs --tenant <id>. The blueprint's exchange token is issued per tenant, so there is no organizations authority for this flow.";
export const AGENT_NEEDS_IDS =
  "--agent needs --blueprint-id <appId> and --agent-id <appId>: the blueprint holds the credential, and the agent identity is the client Graph sees.";
export const AGENT_NEEDS_MODE =
  "--agent needs --mode read or --mode write. No scope template applies, so the mode is the only thing deciding whether this connection may write.";
export const AGENT_REJECTS_APP_ONLY =
  "--agent cannot be combined with --app-only. An agent connection acts for the person who signs in; an app-only one acts for nobody.";
const AGENT_REJECTS_SCOPES =
  "--template and --scopes cannot be combined with --agent. The agent's scopes are the ones granted to its blueprint and inherited, not ones this sign-in asks for.";

export function parseArgs(argv: string[]): CliArgs {
  const [cmd, ...rest] = argv;
  if (!cmd) return { command: "serve" };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { command: "help" };
  if (cmd === "connections") return { command: "connections" };
  if (cmd === "connect") return parseConnect(rest);
  throw new Error(`Unknown command "${cmd}". Run with --help.`);
}

function parseConnect(rest: string[]): CliArgs {
  let appOnly = false;
  let agent = false;
  let blueprintId: string | undefined;
  let agentId: string | undefined;
  let alias: string | undefined;
  let tenant: string | undefined;
  let cloud: string | undefined;
  let clientId: string | undefined;
  let mode: string | undefined;
  let certPath: string | undefined;
  let template: string | undefined;
  let scopes: string[] | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    // The only flag without a value, so the pairing has to stop for it rather than eat the next word.
    if (flag === "--app-only" || flag === "--agent") {
      if (flag === "--app-only") appOnly = true;
      else agent = true;
      continue;
    }
    i += 1;
    const value = rest[i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--alias") alias = value;
    else if (flag === "--tenant") tenant = value;
    else if (flag === "--cloud") cloud = value;
    else if (flag === "--client-id") clientId = value;
    else if (flag === "--mode") mode = value;
    else if (flag === "--cert") certPath = value;
    else if (flag === "--blueprint-id") blueprintId = value;
    else if (flag === "--agent-id") agentId = value;
    else if (flag === "--template") template = value;
    else if (flag === "--scopes") scopes = value.split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`Unknown option ${flag}`);
  }

  if (cloud !== undefined && cloud !== "commercial" && cloud !== "usgov-high") {
    throw new Error(`Unknown cloud "${cloud}". Expected commercial or usgov-high.`);
  }

  if (agent) {
    if (appOnly) throw new Error(AGENT_REJECTS_APP_ONLY);
    if (template !== undefined || scopes !== undefined) throw new Error(AGENT_REJECTS_SCOPES);
    if (tenant === undefined) throw new Error(AGENT_NEEDS_TENANT);
    if (blueprintId === undefined || agentId === undefined) throw new Error(AGENT_NEEDS_IDS);
    if (mode === undefined) throw new Error(AGENT_NEEDS_MODE);
    if (mode !== "read" && mode !== "write") throw new Error(`Unknown mode "${mode}". Expected read or write.`);
    const out: Extract<CliArgs, { command: "connect-agent" }> = { command: "connect-agent", tenantId: tenant, blueprintId, agentId, mode };
    if (certPath !== undefined) out.certPath = certPath;
    if (alias !== undefined) out.alias = alias;
    if (cloud !== undefined) out.cloud = cloud;
    return out;
  }
  if (blueprintId !== undefined) throw new Error("--blueprint-id is only used with --agent.");
  if (agentId !== undefined) throw new Error("--agent-id is only used with --agent.");

  // Validated after the loop, not inside it, so a flag that cannot go with --app-only is rejected
  // whichever order the two were typed in.
  if (appOnly) {
    if (template !== undefined) throw new Error(APP_ONLY_REJECTS_TEMPLATE);
    if (scopes !== undefined) throw new Error(APP_ONLY_REJECTS_SCOPES);
    if (tenant === undefined) throw new Error(APP_ONLY_NEEDS_TENANT);
    if (clientId === undefined) throw new Error(APP_ONLY_NEEDS_CLIENT_ID);
    if (mode === undefined) throw new Error(APP_ONLY_NEEDS_MODE);
    if (mode !== "read" && mode !== "write") throw new Error(`Unknown mode "${mode}". Expected read or write.`);
    const out: Extract<CliArgs, { command: "connect-app-only" }> = { command: "connect-app-only", tenantId: tenant, clientId, mode };
    if (alias !== undefined) out.alias = alias;
    if (cloud !== undefined) out.cloud = cloud;
    if (certPath !== undefined) out.certPath = certPath;
    return out;
  }

  if (clientId !== undefined) throw new Error("--client-id is only used with --app-only. A delegated sign-in uses the configured client id.");
  if (mode !== undefined) throw new Error("--mode is only used with --app-only or --agent. A delegated connection takes its mode from --template.");
  if (certPath !== undefined) throw new Error("--cert is only used with --app-only or --agent. A delegated sign-in happens in the browser.");
  if (template !== undefined && template !== "read" && template !== "read-write") throw new Error(`Unknown template "${template}". Expected read or read-write.`);

  const out: Extract<CliArgs, { command: "connect" }> = { command: "connect" };
  if (alias !== undefined) out.alias = alias;
  if (tenant !== undefined) out.tenantHint = tenant;
  if (cloud !== undefined) out.cloud = cloud;
  if (template !== undefined) out.template = template as ScopeTemplate;
  if (scopes !== undefined) {
    // The same check connection_add makes. A URL form or .default would be stored as requested
    // while the token names short scopes, and every scope would then read as inherited. #66.
    const bad = scopes.filter((s) => !SCOPE_NAME_RE.test(s));
    if (bad.length) throw new Error(`These do not look like Graph permission names: ${bad.join(", ")}`);
    out.scopes = scopes;
  }
  return out;
}

export interface AppOnlyConnectDeps {
  auth: Pick<MsalAuth, "signInAppOnly">;
  store: Pick<ConnectionStore, "upsert">;
}

/**
 * The whole app-only sign-in, split out from argument handling so it can be driven with fake
 * streams. The credential never reaches a variable outside this function.
 */
export async function connectAppOnly(
  deps: AppOnlyConnectDeps,
  args: Extract<CliArgs, { command: "connect-app-only" }>,
  io: PromptIo & { stdout?: NodeJS.WritableStream } = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const credential = await promptSecret(args.certPath ? `Certificate password for ${args.certPath}: ` : "Client secret: ", io);
  const { connection } = await deps.auth.signInAppOnly({
    tenantId: args.tenantId,
    clientId: args.clientId,
    mode: args.mode,
    cloud: args.cloud,
    credential,
    certPath: args.certPath,
    alias: args.alias,
  });
  await deps.store.upsert(connection);
  // Names what was created and nothing about the credential, not even its length.
  stdout.write(`Connected "${connection.alias}" (${connection.tenantName ?? connection.tenantId}) as app ${connection.clientId}, mode ${modeOf(connection)}\n`);
}

export interface AgentConnectDeps {
  auth: Pick<MsalAuth, "signInAgent">;
  store: Pick<ConnectionStore, "upsert">;
}

/**
 * The agent sign-in: the blueprint's credential from the terminal, then the person in the browser.
 * Split out from argument handling, like connectAppOnly, so it can be driven with fake streams.
 */
export async function connectAgent(
  deps: AgentConnectDeps,
  args: Extract<CliArgs, { command: "connect-agent" }>,
  io: PromptIo & { stdout?: NodeJS.WritableStream } = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const credential = await promptSecret(args.certPath ? `Certificate password for ${args.certPath}: ` : "Blueprint client secret: ", io);
  const { connection } = await deps.auth.signInAgent({
    tenantId: args.tenantId,
    blueprintId: args.blueprintId,
    agentId: args.agentId,
    mode: args.mode,
    ...(args.cloud ? { cloud: args.cloud } : {}),
    credential,
    certPath: args.certPath,
    alias: args.alias,
  });
  await deps.store.upsert(connection);
  stdout.write(`Connected "${connection.alias}" (${connection.tenantName ?? connection.tenantId}) as agent ${connection.agentId} for ${connection.username}, mode ${modeOf(connection)}\n`);
}

const HELP = `graphslayer

  graphslayer                 Start the MCP server on stdio (what your MCP client runs)
  graphslayer connect         Sign in to a tenant in the browser and store the connection
      --alias <name>           Short name for the connection
      --tenant <id|domain>     Tenant to sign into (default: any organization)
      --cloud commercial|usgov-high
                               Microsoft cloud the tenant lives in (default: commercial)
      --template read|read-write
                               Scope template to request (default: read)
      --scopes a,b,c           Delegated Graph permissions to request (overrides template scopes)
  graphslayer connect --app-only
                               Sign in as an application and store the connection. Prompts for the
                               client secret, or for the certificate password with --cert.
      --tenant <id>            Tenant to sign into (required)
      --cloud commercial|usgov-high
                               Microsoft cloud the tenant lives in (default: commercial)
      --client-id <id>         Your own app registration (required)
      --mode read|write        Whether this connection may write (required)
      --cert <path>            PEM holding the certificate and its encrypted private key
      --alias <name>           Short name for the connection
  graphslayer connect --agent Have an Entra Agent ID agent identity act for you. Prompts for the
                               blueprint's certificate password (or secret), then opens the browser.
      --tenant <id>            Tenant to sign into (required)
      --blueprint-id <appId>   The agent identity blueprint, which holds the credential (required)
      --agent-id <appId>       The agent identity Graph sees (required)
      --cert <path>            PEM holding the blueprint certificate and its encrypted private key
      --mode read|write        Whether this connection may write (required)
      --alias <name>           Short name for the connection
  graphslayer connections     List stored connections
`;

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "serve") return startStdioServer();
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const deps = await buildDeps();
  if (args.command === "connections") {
    for (const c of await deps.store.list()) {
      process.stdout.write(`${c.alias}\t${c.tenantId}\t${c.tenantName ?? ""}\t${cloudOf(c)}\t${c.kind}\t${modeOf(c)}\t${c.username ?? ""}\n`);
    }
    return;
  }
  if (args.command === "connect-app-only") {
    await connectAppOnly(deps, args);
    return;
  }
  if (args.command === "connect-agent") {
    await connectAgent(deps, args);
    return;
  }
  const { connection } = await deps.auth.signInDelegated({ alias: args.alias, tenantHint: args.tenantHint, cloud: args.cloud, scopes: args.scopes, template: args.template });
  await deps.store.upsert(connection);
  process.stdout.write(`Connected "${connection.alias}" (${connection.tenantName ?? connection.tenantId}) as ${connection.username}, mode ${modeOf(connection)}\n`);
  const note = inheritedScopesReport(connection)?.inheritedScopesNote;
  if (note) process.stdout.write(`${note}\n`);
}

/**
 * Whether this module is the program being run. npm and npx start the bin through a symlink in
 * node_modules/.bin, so the path in argv names the link while import.meta.url names the file it
 * points to. Both are resolved before comparing; comparing them raw made every npx start exit
 * silently (#63).
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
