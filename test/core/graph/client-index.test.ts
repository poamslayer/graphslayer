import { describe, expect, it, vi } from "vitest";

import { GraphClient } from "../../../src/core/graph/client.js";
import { GraphError } from "../../../src/core/graph/errors.js";
import type { GraphIndex } from "../../../src/core/index/graph-index.js";
import type { LoadedIndex } from "../../../src/core/index/loader.js";
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

const index: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: {},
  enums: {},
  paths: {
    "/users": { methods: ["get"], consistency: true },
    "/users/{user-id}": { methods: ["get"] },
    "/users/{user-id}/messages": { methods: ["get"] },
    // Marked by Microsoft, and outside the list plan 1 hardcoded.
    "/me/memberOf": { methods: ["get"], consistency: true },
    "/groups/{group-id}/members": { methods: ["get"], consistency: true },
    "/directoryRoles": { methods: ["get"] },
  },
};

/** Stands in for the loader `search` is given, which the client shares. */
const load = async (): Promise<LoadedIndex> => {
  const text = JSON.stringify(index);
  return { index, text, loadMs: 0, bytes: Buffer.byteLength(text) };
};

const noIndex = async (): Promise<LoadedIndex> => {
  throw new Error("no index on disk");
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const notFound = () => json(404, { error: { code: "Request_ResourceNotFound", message: "Resource not found" } });

function clientWithIndex(fetchImpl: typeof fetch) {
  return new GraphClient(tokens, { fetchImpl, sleep: async () => {}, index: load });
}

describe("the index follows the connection cloud", () => {
  it("asks the shared loader for the GCC High catalogue", async () => {
    const cloudLoad = vi.fn(load);
    const client = new GraphClient(tokens, {
      fetchImpl: vi.fn(async () => json(200, { id: "1" })) as never,
      index: cloudLoad,
    });

    await client.get({ ...conn, cloud: "usgov-high" }, "/users/1");

    expect(cloudLoad).toHaveBeenCalledWith("usgov-high");
  });
});

describe("the consistency header comes from the index", () => {
  it("sets it for a path the index marks that plan 1's list never covered", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("$count=true");
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return json(200, { value: [] });
    });

    await clientWithIndex(fetchImpl as never).list(conn, "/me/memberOf", { filter: "startsWith(displayName,'a')" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves a real id onto the placeholder the index holds", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("$count=true");
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return json(200, { value: [] });
    });

    await clientWithIndex(fetchImpl as never)
      .list(conn, "/groups/8d1a4f00-0000-0000-0000-000000000002/members", { search: "\"displayName:a\"" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback for a path the index does not mark", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return json(200, { value: [] });
    });

    await clientWithIndex(fetchImpl as never).list(conn, "/users/abc/manager", { filter: "x" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends no header and no $count when neither the index nor the fallback asks for one", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).not.toContain("$count");
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBeUndefined();
      return json(200, { value: [] });
    });

    await clientWithIndex(fetchImpl as never).list(conn, "/directoryRoles", { filter: "displayName eq 'x'" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still sets the header when the index cannot be loaded at all", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return json(200, { value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl: fetchImpl as never, index: noIndex });

    await client.list(conn, "/users", { filter: "x" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("a 404 answers from the index", () => {
  it("names the closest paths and points at search", async () => {
    const client = clientWithIndex(vi.fn(notFound) as never);

    const error: GraphError = await client.get(conn, "/groups/abc/member").catch((e) => e);

    expect(error).toBeInstanceOf(GraphError);
    expect(error.status).toBe(404);
    expect(error.hint).toContain("/groups/{group-id}/members");
    expect(error.hint).toContain("search");
    expect(error.toJSON().hint).toBe(error.hint);
  });

  it("surfaces the right path when a nested segment was the singular name", async () => {
    const client = clientWithIndex(vi.fn(notFound) as never);

    const error: GraphError = await client.get(conn, "/users/abc/message").catch((e) => e);

    expect(error.hint).toContain("/users/{user-id}/messages");
  });

  it("hints on the 400 Graph answers a wrong first segment with, not only on a 404", async () => {
    // Probed against a live tenant: "/user" comes back 400 BadRequest "Resource not found for
    // the segment 'user'", while "/me/member" and a good path with a bad id come back 404. The
    // wrong first segment is the near miss the index is best placed to correct, and hinting
    // only on the 404 would miss it entirely.
    const wrongSegment = () => json(400, { error: { code: "BadRequest", message: "Resource not found for the segment 'user'." } });
    const client = clientWithIndex(vi.fn(wrongSegment) as never);

    const error: GraphError = await client.list(conn, "/user").catch((e) => e);

    expect(error.status).toBe(400);
    expect(error.hint).toContain("/users");
  });

  it("leaves a 400 about the query itself alone", async () => {
    // A filter Graph refuses is not a path it cannot find. Offering paths there is noise.
    const refused = () => json(400, { error: { code: "Request_UnsupportedQuery", message: "The specified filter is not supported." } });
    const client = clientWithIndex(vi.fn(refused) as never);

    const error: GraphError = await client.list(conn, "/me/memberOf", { filter: "x" }).catch((e) => e);

    expect(error.status).toBe(400);
    expect(error.hint).toBeUndefined();
  });

  it("says plainly that nothing is close rather than offering something unrelated", async () => {
    const client = clientWithIndex(vi.fn(notFound) as never);

    const error: GraphError = await client.get(conn, "/frobnicate").catch((e) => e);

    expect(error.hint).toContain("no path close");
    expect(error.hint).toContain("search");
    expect(error.hint).not.toMatch(/\/users|\/groups|\/me/);
  });

  it("says the path is a real one when the index holds it, so the id is the suspect", async () => {
    const client = clientWithIndex(vi.fn(notFound) as never);

    const error: GraphError = await client.get(conn, "/users/no-such-user").catch((e) => e);

    expect(error.hint).toContain("/users/{user-id}");
    expect(error.hint).toMatch(/missing object or a wrong id/);
  });

  it("leaves other statuses alone", async () => {
    const client = clientWithIndex(vi.fn(async () => json(403, { error: { code: "Denied", message: "no" } })) as never);

    const error: GraphError = await client.get(conn, "/user").catch((e) => e);

    expect(error.status).toBe(403);
    expect(error.hint).toBeUndefined();
  });

  it("says nothing extra when there is no index to say it from", async () => {
    const client = new GraphClient(tokens, { fetchImpl: vi.fn(notFound) as never, index: noIndex });

    const error: GraphError = await client.get(conn, "/groups/abc/member").catch((e) => e);

    expect(error.status).toBe(404);
    expect(error.hint).toBeUndefined();
  });

  it("hints on a batch entry, which fails as data rather than as a thrown error", async () => {
    const fetchImpl = vi.fn(async () => json(200, {
      responses: [{ id: "0", status: 404, body: { error: { code: "Request_ResourceNotFound", message: "Resource 'member' does not exist." } } }],
    }));
    const client = clientWithIndex(fetchImpl as never);

    const [entry] = await client.batch(conn, [{ path: "/groups/abc/member" }]);

    expect(entry.status).toBe(404);
    const { error } = entry.body as { error: { code: string; hint?: string } };
    expect(error.code).toBe("Request_ResourceNotFound");
    expect(error.hint).toContain("/groups/{group-id}/members");
  });

  it("leaves a batch entry that failed for another reason alone", async () => {
    const fetchImpl = vi.fn(async () => json(200, {
      responses: [{ id: "0", status: 403, body: { error: { code: "Denied", message: "Insufficient privileges" } } }],
    }));
    const client = clientWithIndex(fetchImpl as never);

    const [entry] = await client.batch(conn, [{ path: "/groups/abc/member" }]);

    expect((entry.body as { error: { hint?: string } }).error.hint).toBeUndefined();
  });

  it("hints on a count, naming the collection rather than its $count segment", async () => {
    const client = clientWithIndex(vi.fn(notFound) as never);

    const error: GraphError = await client.count(conn, "/user").catch((e) => e);

    expect(error.hint).toContain("/users");
    expect(error.hint).not.toContain("$count");
  });
});
