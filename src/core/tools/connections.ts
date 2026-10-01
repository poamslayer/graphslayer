import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MsalAuth } from "../auth/msal.js";
import { inheritedScopesReport, SCOPE_NAME_RE } from "../auth/scopes.js";
import { cloudOf, modeOf, type ConnectionStore } from "../connections/store.js";
import { appOnlySecretAccount, type SecretStore } from "../secrets/keychain.js";
import type { Connection } from "../types.js";
import { capJson } from "./output.js";

export interface ConnectionToolDeps {
  store: Pick<ConnectionStore, "list" | "resolve" | "upsert" | "remove">;
  auth: Pick<MsalAuth, "signInDelegated" | "removeAccount">;
  /** Cleared alongside an app-only connection, so removing one leaves no credential behind. */
  secrets: Pick<SecretStore, "delete">;
}

/**
 * The keychain entry a connection's credential lives under, if it has one. App-only keeps it under
 * its own client id, an agent connection under its blueprint's, and a delegated one has none.
 */
function credentialAccount(connection: Connection): string | undefined {
  if (connection.kind === "app") return appOnlySecretAccount(connection.tenantId, connection.clientId);
  if (connection.kind === "agent" && connection.blueprintId) return appOnlySecretAccount(connection.tenantId, connection.blueprintId);
  return undefined;
}

function publicView(c: Connection) {
  return { alias: c.alias, tenantId: c.tenantId, tenantName: c.tenantName, cloud: cloudOf(c), kind: c.kind, mode: modeOf(c), clientId: c.clientId, ...(c.agentId ? { agentId: c.agentId, blueprintId: c.blueprintId } : {}), username: c.username, scopes: c.scopes, ...inheritedScopesReport(c), addedAt: c.addedAt };
}

const connectionShape = z.object({
  alias: z.string(),
  tenantId: z.string(),
  tenantName: z.string().optional(),
  cloud: z.enum(["commercial", "usgov-high"]),
  kind: z.enum(["delegated", "app", "agent"]),
  mode: z.enum(["read", "write"]),
  clientId: z.string(),
  agentId: z.string().optional(),
  blueprintId: z.string().optional(),
  username: z.string().optional(),
  scopes: z.array(z.string()),
  requestedScopes: z.array(z.string()).optional(),
  inheritedScopes: z.array(z.string()).optional(),
  inheritedScopesNote: z.string().optional(),
  addedAt: z.string(),
});

export function registerConnectionTools(server: McpServer, deps: ConnectionToolDeps): void {
  server.registerTool(
    "connections_list",
    {
      title: "List tenant connections",
      description: "List the signed-in tenant connections. Use the alias or tenant id as the tenant argument of other tools.",
      inputSchema: {},
      outputSchema: { connections: z.array(connectionShape) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const connections = (await deps.store.list()).map(publicView);
      return { content: [{ type: "text", text: capJson({ connections }).text }], structuredContent: { connections } };
    },
  );

  server.registerTool(
    "connection_add",
    {
      title: "Sign in to a tenant",
      description:
        "Open the browser so a person can sign in to a Microsoft 365 tenant and consent to scopes. Choose the read-write template for a connection that execute may write with. Delegated only. Never pass tokens or secrets. For app-only connections, the person runs `graphslayer connect --app-only` in a terminal.",
      inputSchema: {
        alias: z.string().optional().describe("Short name for the connection. Defaults to the tenant name."),
        tenantHint: z.string().optional().describe("Tenant id or verified domain to sign into. Defaults to any organization."),
        cloud: z.enum(["commercial", "usgov-high"]).optional().describe("Microsoft cloud the tenant lives in. Defaults to commercial."),
        template: z.enum(["read", "read-write"]).optional().describe("Scope template to request. Defaults to read; execute writes only through a read-write connection."),
        scopes: z.array(z.string()).optional().describe("Delegated Graph permissions to request, e.g. User.Read.All. Non-empty explicit scopes override the template's scope list."),
      },
      outputSchema: { connection: connectionShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ alias, tenantHint, cloud, template, scopes }) => {
      const bad = (scopes ?? []).filter((s) => !SCOPE_NAME_RE.test(s));
      if (bad.length) {
        return { isError: true, content: [{ type: "text", text: `These do not look like Graph permission names: ${bad.join(", ")}` }] };
      }
      const { connection } = await deps.auth.signInDelegated({ alias, tenantHint, scopes, template, ...(cloud ? { cloud } : {}) });
      await deps.store.upsert(connection);
      const view = publicView(connection);
      return { content: [{ type: "text", text: capJson({ connection: view }).text }], structuredContent: { connection: view } };
    },
  );

  server.registerTool(
    "connection_remove",
    {
      title: "Remove a tenant connection",
      description: "Remove a stored connection and its cached sign-in.",
      inputSchema: { alias: z.string() },
      outputSchema: { removed: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ alias }) => {
      const existing = await deps.store.resolve(alias);
      // The cached sign-in belongs to the account, not to this record, and an agent connection
      // always shares it with the person's delegated connections. Removing it while another
      // connection still uses it would sign that connection out as well.
      if (existing?.homeAccountId) {
        const shared = (await deps.store.list()).some((c) => c.alias !== existing.alias && c.homeAccountId === existing.homeAccountId);
        if (!shared) await deps.auth.removeAccount(existing);
      } else if (existing) {
        await deps.auth.removeAccount(existing);
      }
      const account = existing && credentialAccount(existing);
      if (existing && account) {
        // Tolerant on purpose. An entry a person already deleted by hand must not be able to
        // strand the connection record, which would leave an unusable connection nothing removes.
        await deps.secrets.delete(account).catch(() => false);
      }
      const removed = await deps.store.remove(alias);
      return { content: [{ type: "text", text: JSON.stringify({ removed }) }], structuredContent: { removed } };
    },
  );
}
