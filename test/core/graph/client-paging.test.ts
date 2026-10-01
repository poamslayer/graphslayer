import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "../../../src/core/graph/client.js";
import { encodeCursor } from "../../../src/core/graph/query.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};
const tokens = { getGraphToken: async () => "tok" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GraphClient.list", () => {
  it("sends accept application/json", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["accept"]).toBe("application/json");
      return json({ value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    await client.list(conn, "/users");
  });

  it("returns items and an opaque cursor", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).not.toContain("$top");
      return json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=zz" });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const page = await client.list(conn, "/users");
    expect(page.items).toEqual([{ id: "1" }]);
    expect(page.nextCursor).toBe(encodeCursor("https://graph.microsoft.com/v1.0/users?$skiptoken=zz"));
  });

  it("sends no page size unless the script asked for one", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscribedSkus");
      return json({ value: [{ skuId: "a" }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const page = await client.list(conn, "/subscribedSkus");
    expect(page.items).toEqual([{ skuId: "a" }]);
  });

  it("sends the page size the script asked for", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("$top=25");
      return json({ value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    await client.list(conn, "/users", { top: 25 });
  });

  it("follows a cursor instead of building a url", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users?$skiptoken=zz");
      return json({ value: [{ id: "2" }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const page = await client.list(conn, "/users", { cursor: encodeCursor("https://graph.microsoft.com/v1.0/users?$skiptoken=zz") });
    expect(page.items).toEqual([{ id: "2" }]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("caps $top at 999", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("$top=999");
      return json({ value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    await client.list(conn, "/users", { top: 5000 });
  });
});

describe("GraphClient.all", () => {
  it("walks pages until done or until max is reached", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 3) return json({ value: [{ n }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/users?$skiptoken=${n}` });
      return json({ value: [{ n }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/users", {}, 10);
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops at max", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ value: [{ a: 1 }, { a: 2 }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=1" }),
    );
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/users", {}, 3);
    expect(items).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("walks a collection that refuses a page size, because it sends none", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      // Graph answers 400 Request_UnsupportedQuery when this collection is sent any $top.
      if (url.includes("$top")) return json({ error: { code: "Request_UnsupportedQuery", message: "This resource does not support custom page sizes." } }, 400);
      return json({ value: [{ skuId: "a" }, { skuId: "b" }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/subscribedSkus");
    expect(items).toEqual([{ skuId: "a" }, { skuId: "b" }]);
    expect(seen).toEqual(["https://graph.microsoft.com/v1.0/subscribedSkus"]);
  });

  it("walks with the page size the script asked for", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      n += 1;
      if (n === 1) expect(url).toContain("$top=999");
      if (n < 2) return json({ value: [{ n }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=1" });
      return json({ value: [{ n }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/users", { top: 999 }, 10);
    expect(items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("passes every page request through the wrapper the caller supplies", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 3) return json({ value: [{ n }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/users?$skiptoken=${n}` });
      return json({ value: [{ n }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    let wrapped = 0;
    const items = await client.all(conn, "/users", {}, 10, (fetchPage) => {
      wrapped += 1;
      return fetchPage();
    });
    expect(wrapped).toBe(3);
    expect(items).toHaveLength(3);
  });

  it("stops walking when the wrapper throws", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ value: [{ a: 1 }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=1" }),
    );
    const client = new GraphClient(tokens, { fetchImpl });
    await expect(
      client.all(conn, "/users", {}, 100, () => {
        throw new Error("Graph call limit of 2 reached for this run");
      }),
    ).rejects.toThrow(/call limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("GraphClient.batch", () => {
  it("posts to $batch and returns bodies in request order", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/$batch");
      const sent = JSON.parse(String(init.body)) as { requests: Array<{ id: string; url: string; method: string }> };
      expect(sent.requests.map((r) => r.url)).toEqual(["/users/a?$select=id", "/users/b"]);
      return json({
        responses: [
          { id: "1", status: 404, body: { error: { code: "NotFound", message: "no" } } },
          { id: "0", status: 200, body: { id: "a" } },
        ],
      });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const out = await client.batch(conn, [
      { path: "/users/a", opts: { select: ["id"] } },
      { path: "/users/b" },
    ]);
    expect(out).toEqual([
      { status: 200, body: { id: "a" } },
      { status: 404, body: { error: { code: "NotFound", message: "no" } } },
    ]);
  });

  it("refuses to mix v1.0 and beta in one batch", async () => {
    const fetchImpl = vi.fn();
    const client = new GraphClient(tokens, { fetchImpl });
    await expect(
      client.batch(conn, [{ path: "/users/a" }, { path: "/users/b", opts: { beta: true } }]),
    ).rejects.toThrow(/may not mix v1.0 and beta/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects more than 20 requests", async () => {
    const client = new GraphClient(tokens, { fetchImpl: vi.fn() });
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `/users/${i}` }));
    await expect(client.batch(conn, many)).rejects.toThrow(/20/);
  });
});

describe("GraphClient.count", () => {
  it("sends accept text/plain", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["accept"]).toBe("text/plain");
      return new Response("42", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    await client.count(conn, "/users");
  });

  it("calls $count with the consistency header and returns a number", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users/$count?$filter=accountEnabled%20eq%20true");
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return new Response("42", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    expect(await client.count(conn, "/users", "accountEnabled eq true")).toBe(42);
  });
});
