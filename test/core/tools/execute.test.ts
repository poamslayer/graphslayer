import { describe, it, expect, vi, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GraphClient } from "../../../src/core/graph/client.js";
import { createIndexLoader } from "../../../src/core/index/loader.js";
import { createServer } from "../../../src/core/server.js";
import { MiniflareSandbox } from "../../../src/transport/stdio/miniflare-sandbox.js";
import { EXECUTE_DESCRIPTION } from "../../../src/core/tools/execute.js";
import type { Connection } from "../../../src/core/types.js";

const sandbox = new MiniflareSandbox({ timeoutMs: 15_000 });
afterAll(() => sandbox.dispose());

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

/** No username, because an app-only call runs as the application rather than as a person. */
const appConn: Connection = {
  alias: "contoso-app",
  tenantId: "00000000-0000-0000-0000-000000000003",
  kind: "app",
  mode: "read",
  clientId: "app-client-id",
  scopes: ["User.Read.All"],
  addedAt: "2026-09-16T00:00:00.000Z",
};

/** A delegated connection added with the read-write template. */
const writeConn: Connection = { ...conn, alias: "contoso-write", mode: "write" };

function deps() {
  const store = {
    list: async () => [conn, appConn, writeConn],
    resolve: async (k: string) =>
      k === "contoso-app" || k === appConn.tenantId ? appConn : k === "contoso" || k === conn.tenantId ? conn : k === "contoso-write" ? writeConn : undefined,
    upsert: async () => {},
    remove: async () => false,
  };
  const client = {
    get: vi.fn(async (_c: Connection, path: string) => ({ id: path })),
    list: vi.fn(async () => ({ items: [{ displayName: "A" }, { displayName: "B" }] })),
    all: vi.fn(async () => []),
    batch: vi.fn(async () => []),
    count: vi.fn(async () => 2),
    request: vi.fn(async (_c: Connection, method: string) => (method === "DELETE" ? { status: 204, body: null } : { status: 201, body: { id: "g1" } })),
  };
  const auth = { signInDelegated: vi.fn(), getGraphToken: async () => "tok" };
  // search's index sandbox. Nothing here runs an index run, so building one is a fault.
  const indexSandbox = vi.fn(() => { throw new Error("no index run in this test"); });
  return { store, client, auth, sandbox, indexSandbox };
}

async function connect(d: ReturnType<typeof deps>) {
  const server = createServer({ store: d.store as never, client: d.client as never, auth: d.auth as never, sandbox: d.sandbox, indexSandbox: d.indexSandbox });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

describe("execute", () => {
  it("is registered as a tool that can write, with a small description", async () => {
    const mcp = await connect(deps());
    const tools = (await mcp.listTools()).tools;
    const run = tools.find((t) => t.name === "execute");
    expect(run).toBeDefined();
    expect(run?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(EXECUTE_DESCRIPTION).toContain("graph.request");
    expect(EXECUTE_DESCRIPTION.length).toBeLessThan(8000);
  });

  it("writes from inside a script on a write connection, and returns what Graph answered (#78)", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({
      name: "execute",
      arguments: { tenant: "contoso-write", code: `
        const made = await graph.request({ method: "POST", path: "/groups", body: { displayName: "x" } });
        const gone = await graph.request({ method: "DELETE", path: "/groups/" + made.body.id });
        return { made, gone };` },
    });
    const sc = res.structuredContent as { ok: boolean; result: unknown; calls: Array<{ method: string; path: string }> };

    expect(sc.ok).toBe(true);
    expect(sc.result).toEqual({ made: { status: 201, body: { id: "g1" } }, gone: { status: 204 } });
    expect(sc.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /groups", "DELETE /groups/g1"]);
  });

  it("lets the script see a read connection's refusal, and sends nothing (#78)", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({
      name: "execute",
      arguments: { tenant: "contoso", code: `await graph.request({ method: "PATCH", path: "/groups/1", body: {} }); return "wrote";` },
    });
    const sc = res.structuredContent as { ok: boolean; error?: { message: string } };

    expect(sc.ok).toBe(false);
    expect(sc.error?.message).toContain("read mode");
    expect(d.client.request).not.toHaveBeenCalled();
  });

  it("runs a script and returns structured content with calls", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({
      name: "execute",
      arguments: { tenant: "contoso", code: "const p = await graph.list('/users'); return p.items.map(u => u.displayName);" },
    });
    const sc = res.structuredContent as { ok: boolean; result: unknown; calls: Array<{ path: string }>; tenant: string; truncated: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.result).toEqual(["A", "B"]);
    expect(sc.calls[0].path).toBe("/users");
    expect(sc.tenant).toBe(conn.tenantId);
    expect(sc.truncated).toBe(false);
  });

  it("sets the consistency header for a script the model never wrote one into", async () => {
    // The whole point of #23, end to end: /me/memberOf is marked by Microsoft and was outside
    // plan 1's hardcoded list, so before the index this script came back as a Graph error.
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ value: [{ id: "g1" }] }), { headers: { "content-type": "application/json" } });
    });
    const client = new GraphClient({ getGraphToken: async () => "tok" }, {
      fetchImpl: fetchImpl as never,
      index: createIndexLoader(),
    });
    const mcp = await connect({ ...deps(), client: client as never });

    const res = await mcp.callTool({
      name: "execute",
      arguments: {
        tenant: "contoso",
        code: "const p = await graph.list('/me/memberOf', { filter: \"startsWith(displayName,'a')\" }); return p.items.length;",
      },
    });

    expect((res.structuredContent as { ok: boolean; result: unknown }).result).toBe(1);
    expect(sent[0].url).toContain("$count=true");
    expect(sent[0].headers["consistencylevel"]).toBe("eventual");
  });

  it("returns an error result for an unknown tenant", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "execute", arguments: { tenant: "nope", code: "return 1;" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("connections_list");
  });

  it("returns ok false with the script error and logs when the script throws", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "execute", arguments: { tenant: "contoso", code: "console.log('before'); throw new Error('boom');" } });
    const sc = res.structuredContent as { ok: boolean; error?: { message: string; line?: number }; logs: string[] };
    expect(sc.ok).toBe(false);
    expect(sc.error?.message).toContain("boom");
    expect(sc.error?.line).toBe(1);
    expect(sc.logs).toEqual(["before"]);
  });
});
