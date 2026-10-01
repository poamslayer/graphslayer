import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphClient } from "../../src/core/graph/client.js";
import type { GraphIndex } from "../../src/core/index/graph-index.js";
import { createIndexLoader } from "../../src/core/index/loader.js";
import { createServer } from "../../src/core/server.js";
import type { Connection } from "../../src/core/types.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const index: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: { "microsoft.graph.user": { properties: { id: "Edm.String" } } },
  enums: {},
  paths: { "/users": { methods: ["get"], consistency: true, entityType: "microsoft.graph.user" } },
};

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

describe("one index for the whole server", () => {
  it("reads the index file once for both the Graph client and search", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-server-"));
    const file = join(directory, "graph-index.json");

    try {
      await writeFile(file, JSON.stringify(index));
      vi.mocked(readFile).mockClear();

      // The one loader the transport builds, handed to both readers. Two loaders would parse
      // the shipped index twice, which is 3.5 MB of work and memory for the same answer.
      const load = createIndexLoader(file);
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } }));
      const client = new GraphClient({ getGraphToken: async () => "tok" }, { fetchImpl: fetchImpl as never, index: load });
      const server = createServer({
        store: { resolve: async () => conn, list: async () => [conn], upsert: async () => {}, remove: async () => false } as never,
        client,
        auth: {} as never,
        sandbox: { run: async () => { throw new Error("no run in this test"); } },
        indexSandbox: () => ({ run: async () => ({ ok: true, data: 1, logs: [] }) }),
        index: load,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const mcp = new Client({ name: "test", version: "0.0.0" });
      await mcp.connect(clientTransport);

      // The client reads the index to decide the consistency header...
      await client.list(conn, "/users", { filter: "startsWith(displayName,'a')" });
      // ...and search reads it to build the index sandbox.
      await mcp.callTool({ name: "search", arguments: { code: "return 1;" } });

      const indexReads = vi.mocked(readFile).mock.calls.filter(([target]) => target === file);
      expect(indexReads).toHaveLength(1);
      await mcp.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
