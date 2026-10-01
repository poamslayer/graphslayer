import { describe, it, expect, vi, afterAll } from "vitest";
import { makeBinding } from "../../../src/core/sandbox/binding.js";
import { MiniflareSandbox } from "../../../src/transport/stdio/miniflare-sandbox.js";
import { GraphError } from "../../../src/core/graph/errors.js";
import { GraphClient } from "../../../src/core/graph/client.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

function fakeClient() {
  return {
    get: vi.fn(async (_c: Connection, path: string) => ({ id: path })),
    list: vi.fn(async (_c: Connection, path: string) => ({ items: [{ id: `${path}-1` }], nextCursor: undefined })),
    all: vi.fn(async (
      _c: Connection,
      path: string,
      _opts?: unknown,
      _max?: number,
      eachPage: <T>(fetchPage: () => Promise<T>) => Promise<T> = (fetchPage) => fetchPage(),
    ) => eachPage(async () => [{ id: `${path}-a` }, { id: `${path}-b` }])),
    batch: vi.fn(async (_c: Connection, reqs: Array<{ path: string }>) => reqs.map((r) => ({ status: 200, body: { id: r.path } }))),
    count: vi.fn(async () => 7),
    request: vi.fn(async (_c: Connection, method: string, _path: string, _opts?: unknown, _body?: unknown) =>
      method === "DELETE" ? { status: 204, body: null } : { status: method === "POST" ? 201 : 200, body: { id: "new" } }),
  };
}

describe("makeBinding", () => {
  it("dispatches get, list, all, batch, count and records each call", async () => {
    const client = fakeClient();
    const { handle, calls } = makeBinding({ client: client as never, connection: conn });
    expect(await handle("get", ["/users/1"])).toEqual({ id: "/users/1" });
    expect(((await handle("list", ["/users"])) as { items: unknown[] }).items).toHaveLength(1);
    expect(await handle("all", ["/groups"])).toHaveLength(2);
    expect(await handle("batch", [[{ path: "/a" }, { path: "/b" }]])).toEqual([{ id: "/a" }, { id: "/b" }]);
    expect(await handle("count", ["/users", "x"])).toBe(7);
    expect(calls().map((c) => c.path)).toEqual(["/users/1", "/users", "/groups", "/$batch", "/users/$count"]);
  });

  it("passes max through to all()", async () => {
    const client = fakeClient();
    const { handle } = makeBinding({ client: client as never, connection: conn });
    await handle("all", ["/users", { select: ["id"], max: 5 }]);
    expect(client.all).toHaveBeenCalledWith(conn, "/users", { select: ["id"], max: 5 }, 5, expect.any(Function));
  });

  it("returns error objects from batch entries that failed", async () => {
    const client = fakeClient();
    client.batch.mockResolvedValueOnce([{ status: 404, body: { error: { code: "NotFound", message: "no" } } }]);
    const { handle } = makeBinding({ client: client as never, connection: conn });
    expect(await handle("batch", [[{ path: "/x" }]])).toEqual([{ error: { status: 404, code: "NotFound", message: "no" } }]);
  });

  it("turns a GraphError into a plain error the script can catch, and records the status", async () => {
    const client = fakeClient();
    client.get.mockRejectedValueOnce(new GraphError(403, "Authorization_RequestDenied", "Insufficient privileges", "r1"));
    const { handle, calls } = makeBinding({ client: client as never, connection: conn });
    await expect(handle("get", ["/users"])).rejects.toThrow(/Graph 403 Authorization_RequestDenied/);
    expect(calls()[0].status).toBe(403);
  });

  it("carries the index's reading of a 404 through to the script", async () => {
    const client = fakeClient();
    const hint = 'The Graph index holds no path matching "/groups/abc/member". Closest: /groups/{group-id}/members. Call search to find the path you want.';
    client.get.mockRejectedValueOnce(new GraphError(404, "Request_ResourceNotFound", "Resource not found", "r1", undefined, hint));
    const { handle } = makeBinding({ client: client as never, connection: conn });
    // The script, and so the model, sees only this message. A hint that stays on the error
    // object never reaches the one reader who could act on it.
    await expect(handle("get", ["/groups/abc/member"]))
      .rejects.toThrow(/Graph 404 Request_ResourceNotFound[\s\S]*\/groups\/\{group-id\}\/members/);
  });

  it("rejects unknown operations and bad arguments", async () => {
    const { handle } = makeBinding({ client: fakeClient() as never, connection: conn });
    await expect(handle("delete", ["/users/1"])).rejects.toThrow(/Unknown binding operation/);
    await expect(handle("get", [42])).rejects.toThrow(/path must be a string/);
  });

  it("stops after the call cap", async () => {
    const { handle } = makeBinding({ client: fakeClient() as never, connection: conn, maxCalls: 2 });
    await handle("get", ["/a"]);
    await handle("get", ["/b"]);
    await expect(handle("get", ["/c"])).rejects.toThrow(/call limit/);
  });

  describe("inside the sandbox", () => {
    const runner = new MiniflareSandbox({ timeoutMs: 10_000 });
    afterAll(() => runner.dispose());

    it("works end to end", async () => {
      const client = fakeClient();
      const { handle, calls } = makeBinding({ client: client as never, connection: conn });
      const r = await runner.run("const p = await graph.list('/users'); return p.items.map(u => u.id);", handle);
      expect(r.ok).toBe(true);
      expect(r.data).toEqual(["/users-1"]);
      expect(calls()).toHaveLength(1);
    });
  });
});

describe("paging against the call cap", () => {
  const tokens = { getGraphToken: async () => "tok" };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  /** A fetch that serves `pages` pages of one item each, the last one without a next link. */
  function pagingFetch(pages: number) {
    let n = 0;
    return vi.fn(async () => {
      n += 1;
      return n < pages
        ? json({ value: [{ n }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/users?$skiptoken=${n}` })
        : json({ value: [{ n }] });
    });
  }

  it("spends one call and records one entry for each page graph.all fetches", async () => {
    const client = new GraphClient(tokens, { fetchImpl: pagingFetch(3) as never });
    const { handle, calls } = makeBinding({ client, connection: conn });
    expect(await handle("all", ["/users"])).toHaveLength(3);
    expect(calls().map((c) => c.path)).toEqual(["/users", "/users", "/users"]);
  });

  it("stops the walk at the call cap and names the limit", async () => {
    const fetchImpl = pagingFetch(10);
    const client = new GraphClient(tokens, { fetchImpl: fetchImpl as never });
    const { handle, calls } = makeBinding({ client, connection: conn, maxCalls: 2 });
    await expect(handle("all", ["/users"])).rejects.toThrow(/call limit/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls()).toHaveLength(2);
  });
});

describe("graph.request: writes from inside a run (#78)", () => {
  const writer: Connection = { ...conn, mode: "write" };

  it("sends POST, PATCH and PUT with their body, and returns the status and body", async () => {
    const client = fakeClient();
    const { handle, calls } = makeBinding({ client: client as never, connection: writer });

    expect(await handle("request", [{ method: "POST", path: "/groups", body: { displayName: "x" } }])).toEqual({ status: 201, body: { id: "new" } });
    await handle("request", [{ method: "PATCH", path: "/groups/1", body: { description: "d" }, beta: true }]);
    await handle("request", [{ method: "PUT", path: "/groups/1/x", body: { a: 1 } }]);

    expect(client.request.mock.calls.map((c) => [c[1], c[2], c[4]])).toEqual([
      ["POST", "/groups", { displayName: "x" }],
      ["PATCH", "/groups/1", { description: "d" }],
      ["PUT", "/groups/1/x", { a: 1 }],
    ]);
    expect(client.request.mock.calls[1][3]).toMatchObject({ beta: true });
    expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /groups", "PATCH /groups/1", "PUT /groups/1/x"]);
  });

  it("sends a DELETE with no body, and leaves the body out of a 204 answer", async () => {
    const client = fakeClient();
    const { handle } = makeBinding({ client: client as never, connection: writer });

    expect(await handle("request", [{ method: "DELETE", path: "/groups/1", body: { ignored: true } }])).toEqual({ status: 204 });
    expect(client.request.mock.calls[0][4]).toBeUndefined();
  });

  it("passes a GET through with its query options, on a read connection too", async () => {
    const client = fakeClient();
    const { handle } = makeBinding({ client: client as never, connection: conn });

    await handle("request", [{ method: "GET", path: "/users", select: ["id"], top: 5 }]);
    expect(client.request.mock.calls[0].slice(1, 4)).toEqual(["GET", "/users", { select: ["id"], top: 5 }]);
  });

  it.each([
    { kind: "delegated" as const, hint: "read-write template" },
    { kind: "app" as const, hint: "connect --app-only --mode write" },
    { kind: "agent" as const, hint: "connect --agent --mode write" },
  ])("refuses a write on a read $kind connection and sends nothing", async ({ kind, hint }) => {
    const client = fakeClient();
    const { handle, calls } = makeBinding({ client: client as never, connection: { ...conn, kind, mode: "read" } });

    await expect(handle("request", [{ method: "POST", path: "/groups", body: {} }])).rejects.toThrow(/read mode/);
    await expect(handle("request", [{ method: "DELETE", path: "/groups/1" }])).rejects.toThrow(hint);
    expect(client.request).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });

  it("refuses an unknown method, and a request with no path", async () => {
    const { handle } = makeBinding({ client: fakeClient() as never, connection: writer });

    await expect(handle("request", [{ method: "TRACE", path: "/users" }])).rejects.toThrow(/GET, POST, PATCH, PUT or DELETE/);
    await expect(handle("request", [{ method: "GET" }])).rejects.toThrow(/path/);
  });

  it("counts writes against the same call cap as reads", async () => {
    const { handle } = makeBinding({ client: fakeClient() as never, connection: writer, maxCalls: 1 });

    await handle("request", [{ method: "POST", path: "/groups", body: {} }]);
    await expect(handle("request", [{ method: "POST", path: "/groups", body: {} }])).rejects.toThrow(/call limit of 1/);
  });
});
