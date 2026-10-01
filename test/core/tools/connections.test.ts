import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/core/server.js";
import { appOnlySecretAccount, MemorySecretStore } from "../../../src/core/secrets/keychain.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantName: "Contoso",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: ["User.Read"],
  addedAt: "2026-09-15T00:00:00.000Z",
};

/** An app-only connection: no username, because the principal is the application. */
const appConn: Connection = {
  alias: "contoso-app",
  tenantId: "00000000-0000-0000-0000-000000000003",
  tenantName: "Contoso",
  kind: "app",
  mode: "write",
  clientId: "app-client-id",
  scopes: ["User.Read.All"],
  addedAt: "2026-09-16T00:00:00.000Z",
};

/** An agent connection: a person signed in, an agent identity acting for them. ADR-0015. */
const agentConn: Connection = {
  alias: "contoso-agent",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantName: "Contoso",
  kind: "agent",
  mode: "read",
  clientId: "x",
  homeAccountId: "home-1",
  username: "admin@contoso.com",
  agentId: "agent-app-id",
  blueprintId: "blueprint-app-id",
  scopes: ["Directory.Read.All"],
  addedAt: "2026-10-01T00:00:00.000Z",
};

function deps(initial: Connection[] = [conn]) {
  const list = initial.slice();
  const store = {
    list: async () => list.slice(),
    resolve: async (k: string) => list.find((c) => c.alias === k || c.tenantId === k),
    upsert: vi.fn(async (c: Connection) => { list.push(c); }),
    remove: vi.fn(async (alias: string) => {
      const i = list.findIndex((c) => c.alias === alias);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    }),
  };
  const auth = {
    signInDelegated: vi.fn(async (input: { alias?: string; cloud?: "commercial" | "usgov-high"; scopes?: string[]; template?: "read" | "read-write" }) => ({
      connection: {
        ...conn,
        alias: input.alias ?? "fabrikam",
        tenantId: "00000000-0000-0000-0000-000000000002",
        cloud: input.cloud ?? "commercial",
        mode: input.template === "read-write" ? "write" as const : "read" as const,
        scopes: input.scopes ?? (input.template === "read-write" ? ["User.Read", "User.ReadWrite"] : ["User.Read"]),
      },
    })),
    getGraphToken: async () => "tok",
    removeAccount: vi.fn(async () => {}),
  };
  const client = { get: vi.fn(), list: vi.fn(), all: vi.fn(), batch: vi.fn(), count: vi.fn() };
  const secrets = new MemorySecretStore();
  vi.spyOn(secrets, "delete");
  const sandbox = { run: vi.fn() };
  // search's index sandbox. Nothing here runs an index run, so building one is a fault.
  const indexSandbox = vi.fn(() => { throw new Error("no index run in this test"); });
  return { store, auth, client, secrets, sandbox, indexSandbox };
}

async function connect(d: ReturnType<typeof deps>) {
  const server = createServer({ store: d.store as never, client: d.client as never, auth: d.auth as never, secrets: d.secrets, sandbox: d.sandbox, indexSandbox: d.indexSandbox });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

describe("connection tools", () => {
  it("lists connections without secrets", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "connections_list", arguments: {} });
    const sc = res.structuredContent as { connections: Array<Record<string, unknown>> };
    expect(sc.connections).toHaveLength(1);
    expect(sc.connections[0]).toMatchObject({ alias: "contoso", tenantId: conn.tenantId, kind: "delegated", username: "admin@contoso.com" });
    expect(Object.keys(sc.connections[0])).not.toContain("homeAccountId");
  });

  it("lists each connection's resolved mode", async () => {
    const writeConnection: Connection = {
      ...conn,
      alias: "fabrikam",
      tenantId: "00000000-0000-0000-0000-000000000002",
      mode: "write",
    };
    const mcp = await connect(deps([conn, writeConnection]));

    const res = await mcp.callTool({ name: "connections_list", arguments: {} });
    const sc = res.structuredContent as { connections: Array<Record<string, unknown>> };
    expect(sc.connections).toEqual([
      expect.objectContaining({ alias: "contoso", mode: "read" }),
      expect.objectContaining({ alias: "fabrikam", mode: "write" }),
    ]);
  });

  it("accepts an optional cloud and surfaces each connection's resolved cloud", async () => {
    const d = deps();
    const mcp = await connect(d);

    const added = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", cloud: "usgov-high" } });
    const listed = await mcp.callTool({ name: "connections_list", arguments: {} });

    expect(d.auth.signInDelegated).toHaveBeenCalledWith(expect.objectContaining({ cloud: "usgov-high" }));
    expect(added.structuredContent).toEqual({ connection: expect.objectContaining({ alias: "fabrikam", cloud: "usgov-high" }) });
    expect(listed.structuredContent).toEqual({
      connections: [
        expect.objectContaining({ alias: "contoso", cloud: "commercial" }),
        expect.objectContaining({ alias: "fabrikam", cloud: "usgov-high" }),
      ],
    });
  });

  it("adds a connection through interactive sign-in and rejects unknown scopes", async () => {
    const d = deps();
    const mcp = await connect(d);
    const bad = await mcp.callTool({ name: "connection_add", arguments: { alias: "f", scopes: ["not a scope"] } });
    expect(bad.isError).toBe(true);
    const res = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", scopes: ["Group.Read.All"] } });
    expect(res.isError).toBeFalsy();
    expect(d.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ alias: "fabrikam" }));
  });

  it("adds and stores a connection in the mode implied by its template", async () => {
    const d = deps();
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", template: "read-write" } });

    expect(res.isError).toBeFalsy();
    expect(d.auth.signInDelegated).toHaveBeenCalledWith({ alias: "fabrikam", tenantHint: undefined, scopes: undefined, template: "read-write" });
    expect(d.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ alias: "fabrikam", mode: "write" }));
    expect(res.structuredContent).toEqual({ connection: expect.objectContaining({ alias: "fabrikam", mode: "write" }) });
  });

  it("passes explicit scopes with the template so they override its scope list", async () => {
    const d = deps();
    const mcp = await connect(d);

    await mcp.callTool({
      name: "connection_add",
      arguments: { alias: "fabrikam", template: "read-write", scopes: ["Group.Read.All"] },
    });

    expect(d.auth.signInDelegated).toHaveBeenCalledWith({
      alias: "fabrikam",
      tenantHint: undefined,
      scopes: ["Group.Read.All"],
      template: "read-write",
    });
    expect(d.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ mode: "write", scopes: ["Group.Read.All"] }));
  });

  it("says which granted scopes the sign-in did not request, so the result matches the consent screen", async () => {
    const d = deps();
    d.auth.signInDelegated.mockImplementationOnce(async () => ({
      connection: {
        ...conn,
        alias: "fabrikam",
        tenantId: "00000000-0000-0000-0000-000000000002",
        cloud: "commercial" as const,
        mode: "read" as const,
        scopes: ["Directory.ReadWrite.All", "Group.ReadWrite.All", "openid", "profile", "email", "Mail.Read", "Tasks.ReadWrite"],
        requestedScopes: ["Mail.Read", "Tasks.ReadWrite"],
      },
    }));
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", scopes: ["Mail.Read", "Tasks.ReadWrite"] } });

    expect(res.isError).toBeFalsy();
    const { connection } = res.structuredContent as { connection: Record<string, unknown> };
    expect(connection.requestedScopes).toEqual(["Mail.Read", "Tasks.ReadWrite"]);
    // The sign-in scopes MSAL adds to every sign-in are not inherited consent.
    expect(connection.inheritedScopes).toEqual(["Directory.ReadWrite.All", "Group.ReadWrite.All"]);
    expect(connection.inheritedScopesNote).toMatch(/2 scopes this sign-in did not request/);
    expect(connection.inheritedScopesNote).toMatch(/already holds consent/);
  });

  it("adds no note when the token carries only what was requested", async () => {
    const d = deps();
    d.auth.signInDelegated.mockImplementationOnce(async () => ({
      connection: { ...conn, alias: "fabrikam", scopes: ["openid", "profile", "mail.read"], requestedScopes: ["Mail.Read"] },
    }));
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", scopes: ["Mail.Read"] } });

    const { connection } = res.structuredContent as { connection: Record<string, unknown> };
    expect(connection.inheritedScopes).toEqual([]);
    expect(connection).not.toHaveProperty("inheritedScopesNote");
  });

  it("lists a connection stored before requested scopes were kept without claiming a gap", async () => {
    const mcp = await connect(deps([conn]));

    const res = await mcp.callTool({ name: "connections_list", arguments: {} });

    expect(res.isError).toBeFalsy();
    const [listed] = (res.structuredContent as { connections: Array<Record<string, unknown>> }).connections;
    expect(listed).not.toHaveProperty("requestedScopes");
    expect(listed).not.toHaveProperty("inheritedScopes");
    expect(listed).not.toHaveProperty("inheritedScopesNote");
  });

  it("removes a connection and its cached account", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });
    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect(d.auth.removeAccount).toHaveBeenCalled();
    const again = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });
    expect((again.structuredContent as { removed: boolean }).removed).toBe(false);
  });

  it("removes an app-only connection's keychain credential along with its record", async () => {
    const d = deps([appConn]);
    await d.secrets.set(appOnlySecretAccount(appConn.tenantId, appConn.clientId), "s3cret");
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso-app" } });

    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect(d.secrets.delete).toHaveBeenCalledWith(appOnlySecretAccount(appConn.tenantId, appConn.clientId));
    expect(await d.secrets.get(appOnlySecretAccount(appConn.tenantId, appConn.clientId))).toBeUndefined();
  });

  it("leaves the secret store alone when the connection is delegated", async () => {
    const d = deps();
    const mcp = await connect(d);

    await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });

    expect(d.secrets.delete).not.toHaveBeenCalled();
  });

  it("still removes an app-only connection whose keychain entry is already gone", async () => {
    const d = deps([appConn]);
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso-app" } });

    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect(d.secrets.delete).toHaveBeenCalled();
    expect(await d.store.list()).toEqual([]);
  });

  it("removes the record even when clearing the keychain entry throws", async () => {
    const d = deps([appConn]);
    (d.secrets.delete as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("keychain locked"));
    const mcp = await connect(d);

    const res = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso-app" } });

    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
  });

  it("declares annotations", async () => {
    const mcp = await connect(deps());
    const tools = (await mcp.listTools()).tools;
    expect(tools.find((t) => t.name === "connections_list")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "connection_remove")?.annotations?.destructiveHint).toBe(true);
  });
});

describe("connection tools with an agent connection (#72)", () => {
  it("lists an agent connection with its agent and blueprint ids", async () => {
    const mcp = await connect(deps([agentConn]));
    const res = await mcp.callTool({ name: "connections_list", arguments: {} });

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { connections: unknown[] }).connections[0]).toMatchObject({
      alias: "contoso-agent", kind: "agent", agentId: "agent-app-id", blueprintId: "blueprint-app-id", username: "admin@contoso.com",
    });
  });

  it("clears the blueprint credential from the keychain and names both the person and the agent", async () => {
    const d = deps([agentConn]);
    const account = appOnlySecretAccount(agentConn.tenantId, "blueprint-app-id");
    await d.secrets.set(account, "s3cret");
    const mcp = await connect(d);

    await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso-agent" } });

    expect(await d.secrets.get(account)).toBeUndefined();
  });

  it("keeps the cached sign-in while another connection still uses the same account", async () => {
    const d = deps([{ ...conn, homeAccountId: "home-1" }, agentConn]);
    const mcp = await connect(d);

    await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso-agent" } });
    expect(d.auth.removeAccount).not.toHaveBeenCalled();

    await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });
    expect(d.auth.removeAccount).toHaveBeenCalledTimes(1);
  });
});
