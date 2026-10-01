import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "../../../src/core/graph/client.js";
import { GraphError } from "../../../src/core/graph/errors.js";
import { SERVER_VERSION } from "../../../src/core/version.js";
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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GraphClient.request", () => {
  it("sends bearer token, compact accept header, and returns json", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users/abc?$select=id");
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
      return jsonResponse(200, { id: "abc" }, { "request-id": "r1" });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    const res = await client.request(conn, "GET", "/users/abc", { select: ["id"] });
    expect(res.body).toEqual({ id: "abc" });
    expect(res.status).toBe(200);
    expect(res.requestId).toBe("r1");
    expect(res.apiVersion).toBe("v1.0");
  });

  it("sets ConsistencyLevel eventual for advanced directory queries", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return jsonResponse(200, { value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    await client.request(conn, "GET", "/users", { filter: "startsWith(displayName,'a')" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 using Retry-After and then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return jsonResponse(429, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "3" });
      return jsonResponse(200, { ok: true });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const res = await client.request(conn, "GET", "/users");
    expect(res.body).toEqual({ ok: true });
    expect(waits).toEqual([3000]);
  });

  it("gives up after the retry budget and throws a GraphError with status 429", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "1" }));
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {}, maxRetries: 2 });
    await expect(client.request(conn, "GET", "/users")).rejects.toMatchObject({ status: 429, code: "TooManyRequests" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws GraphError with code, message, and request id on 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }, { "request-id": "r9" }),
    );
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    const err = await client.request(conn, "GET", "/users").catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("Authorization_RequestDenied");
    expect(err.requestId).toBe("r9");
  });
});

describe("GraphClient.batch", () => {
  it("sends GCC High sub-request URLs relative to the batch endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.us/v1.0/$batch");
      expect(JSON.parse(String(init.body))).toMatchObject({
        requests: [
          { id: "0", url: "/users?$select=id" },
          { id: "1", url: "/groups?$top=5" },
        ],
      });
      return jsonResponse(200, { responses: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });

    await client.batch({ ...conn, cloud: "usgov-high" }, [
      { path: "/users", opts: { select: ["id"] } },
      { path: "/groups", opts: { top: 5 } },
    ]);
  });
});

describe("GraphClient after a 403 (#73)", () => {
  const forbidden = () => jsonResponse(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } });
  const bearer = (init: RequestInit) => (init.headers as Record<string, string>)["authorization"];

  it("refreshes the token once and retries when the fresh token gained a scope", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(bearer(init));
      return seen.length === 1 ? forbidden() : jsonResponse(200, { ok: true });
    });
    const refreshGraphToken = vi.fn(async () => "fresh");
    const client = new GraphClient({ getGraphToken: async () => "tok", refreshGraphToken }, { fetchImpl, sleep: async () => {} });

    const res = await client.request(conn, "GET", "/identityGovernance/termsOfUse/agreements");

    expect(res.body).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer tok", "Bearer fresh"]);
    expect(refreshGraphToken).toHaveBeenCalledTimes(1);
  });

  it("throws the 403 when the fresh token gained nothing", async () => {
    const fetchImpl = vi.fn(async () => forbidden());
    const client = new GraphClient({ getGraphToken: async () => "tok", refreshGraphToken: async () => undefined }, { fetchImpl, sleep: async () => {} });

    await expect(client.request(conn, "GET", "/users")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries at most once, so a second 403 is thrown", async () => {
    const fetchImpl = vi.fn(async () => forbidden());
    const refreshGraphToken = vi.fn(async () => "fresh");
    const client = new GraphClient({ getGraphToken: async () => "tok", refreshGraphToken }, { fetchImpl, sleep: async () => {} });

    await expect(client.request(conn, "GET", "/users")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshGraphToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for an app-only connection", async () => {
    const fetchImpl = vi.fn(async () => forbidden());
    const refreshGraphToken = vi.fn(async () => "fresh");
    const client = new GraphClient({ getGraphToken: async () => "tok", refreshGraphToken }, { fetchImpl, sleep: async () => {} });

    await expect(client.request({ ...conn, kind: "app" }, "GET", "/users")).rejects.toMatchObject({ status: 403 });
    expect(refreshGraphToken).not.toHaveBeenCalled();
  });

  it("sends a batch again once when an entry was refused and the fresh token gained a scope", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(bearer(init));
      const status = seen.length === 1 ? 403 : 200;
      return jsonResponse(200, { responses: [{ id: "0", status: 200, body: { a: 1 } }, { id: "1", status, body: status === 403 ? { error: { code: "Forbidden", message: "no" } } : { b: 2 } }] });
    });
    const refreshGraphToken = vi.fn(async () => "fresh");
    const client = new GraphClient({ getGraphToken: async () => "tok", refreshGraphToken }, { fetchImpl, sleep: async () => {} });

    const out = await client.batch(conn, [{ path: "/users" }, { path: "/identityGovernance/termsOfUse/agreements" }]);

    expect(out.map((r) => r.status)).toEqual([200, 200]);
    expect(seen).toEqual(["Bearer tok", "Bearer fresh"]);
  });
});

describe("GraphClient identifies itself (#74)", () => {
  it("sends a User-Agent naming the server and its version, so Microsoft's logs can find its calls", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["user-agent"]);
      return jsonResponse(200, { ok: true });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });

    await client.request(conn, "GET", "/users");
    await client.request(conn, "POST", "/groups", {}, { displayName: "x" }, { "user-agent": "something-else" });

    expect(seen).toEqual([`graphslayer/${SERVER_VERSION}`, `graphslayer/${SERVER_VERSION}`]);
  });
});

describe("GraphClient retries a write only when Graph says it did nothing (#78)", () => {
  const statuses = (codes: number[]) => {
    let i = 0;
    return vi.fn(async () => {
      const code = codes[Math.min(i++, codes.length - 1)];
      return code === 200 || code === 201 ? jsonResponse(code, { ok: true }) : jsonResponse(code, { error: { code: "E", message: "busy" } });
    });
  };

  it("does not resend a POST after a 504, because Graph may already have made it", async () => {
    const fetchImpl = statuses([504, 201]);
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });

    await expect(client.request(conn, "POST", "/groups", {}, { displayName: "x" })).rejects.toMatchObject({ status: 504 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still retries a $batch of reads after a 504, because every request in it is a GET", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1
      ? jsonResponse(504, { error: { code: "E", message: "busy" } })
      : jsonResponse(200, { responses: [{ id: "0", status: 200, body: { id: "u" } }] })));
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });

    expect(await client.batch(conn, [{ path: "/users/u" }])).toEqual([{ status: 200, body: { id: "u" } }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still retries a GET after a 504, and a POST after a 429", async () => {
    const getFetch = statuses([504, 200]);
    await new GraphClient(tokens, { fetchImpl: getFetch, sleep: async () => {} }).request(conn, "GET", "/users");
    expect(getFetch).toHaveBeenCalledTimes(2);

    const postFetch = statuses([429, 201]);
    await new GraphClient(tokens, { fetchImpl: postFetch, sleep: async () => {} }).request(conn, "POST", "/groups", {}, {});
    expect(postFetch).toHaveBeenCalledTimes(2);
  });
});
