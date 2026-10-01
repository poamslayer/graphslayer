import { describe, expect, it, vi } from "vitest";

import { GraphClient } from "../../../src/core/graph/client.js";
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
  types: {
    "microsoft.graph.user": {
      properties: { id: "Edm.String", displayName: "Edm.String", surname: "Edm.String" },
      defaultSelect: ["id", "displayName"],
    },
    // A type the curated list does not cover, which is where most of Graph is.
    "microsoft.graph.message": { properties: { id: "Edm.String", subject: "Edm.String" } },
  },
  enums: {},
  paths: {
    "/users": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/{user-id}": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/{user-id}/messages": { methods: ["get"], entityType: "microsoft.graph.message" },
    "/reports/whatever": { methods: ["get"] },
  },
};

const load = async (): Promise<LoadedIndex> => {
  const text = JSON.stringify(index);
  return { index, text, loadMs: 0, bytes: Buffer.byteLength(text) };
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function clientWithIndex(fetchImpl: typeof fetch) {
  return new GraphClient(tokens, { fetchImpl, sleep: async () => {}, index: load });
}

/** The one URL the client built, so a test can assert on what did and did not reach Graph. */
function capture() {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url);
    return json({ value: [] });
  });
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("the default field selection", () => {
  it("shapes a collection read the caller gave no select for", async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).list(conn, "/users");
    // encodeURIComponent spells the separator %2C, which Graph accepts and which every
    // explicit multi-field select has always been sent as.
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/users?$select=id%2CdisplayName");
  });

  it("never overrides a select the caller passed", async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).list(conn, "/users", { select: ["surname"] });
    expect(urls[0]).toContain("$select=surname");
    expect(urls[0]).not.toContain("displayName");
  });

  it('sends no select at all for ["*"], which is how a script asks for the whole object', async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).list(conn, "/users", { select: ["*"] });
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/users");
  });

  it("leaves a path whose type carries no default exactly as it was", async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).list(conn, "/users/abc/messages");
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/users/abc/messages");
  });

  it("leaves a path the index has no entry for exactly as it was", async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).list(conn, "/nothing/here");
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/nothing/here");
  });

  it("does not shape a single-object read, because that is not where the tokens are", async () => {
    const { urls, fetchImpl } = capture();
    await clientWithIndex(fetchImpl).get(conn, "/users/abc");
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/users/abc");
  });

  it("applies to every page of a walk, because all pages through list", async () => {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      n += 1;
      if (n === 1) return json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=z" });
      return json({ value: [{ id: "2" }] });
    });
    await clientWithIndex(fetchImpl as unknown as typeof fetch).all(conn, "/users", {}, 10);
    expect(urls[0]).toContain("$select=id%2CdisplayName");
    // The second page follows the absolute next link, which already carries Graph's own shaping.
    expect(urls[1]).toBe("https://graph.microsoft.com/v1.0/users?$skiptoken=z");
  });

  it("is absent entirely when no index loads, so a Graph call is never gated on one", async () => {
    const { urls, fetchImpl } = capture();
    const client = new GraphClient(tokens, { fetchImpl, index: async () => { throw new Error("no index"); } });
    await client.list(conn, "/users");
    expect(urls[0]).toBe("https://graph.microsoft.com/v1.0/users");
  });
});
