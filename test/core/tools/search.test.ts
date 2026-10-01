import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { RunResult } from "../../../src/core/sandbox/sandbox.js";
import { loadGraphIndex } from "../../../src/core/index/loader.js";
import { createServer } from "../../../src/core/server.js";
import { INDEX_TRUNCATION_NOTE, SEARCH_DESCRIPTION } from "../../../src/core/tools/search.js";
import { DEFAULT_MAX_CHARS, capJson } from "../../../src/core/tools/output.js";

const loaded = await loadGraphIndex();

function deps() {
  const store = {
    list: vi.fn(async () => []),
    resolve: vi.fn(async () => undefined),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => false),
  };
  const client = {
    get: vi.fn(),
    list: vi.fn(),
    all: vi.fn(),
    batch: vi.fn(),
    count: vi.fn(),
  };
  const auth = { signInDelegated: vi.fn(), getGraphToken: vi.fn(), removeAccount: vi.fn() };
  const sandbox = { run: vi.fn(() => { throw new Error("search must not use the run sandbox"); }) };
  const index = vi.fn(async () => loaded);
  // Stands in for the workerd sandbox: it evaluates the script the tool hands it against the
  // preamble the tool built, so a test can see both without starting a second runtime.
  const preambles: string[] = [];
  const indexSandbox = vi.fn((options: { preamble: string }) => {
    preambles.push(options.preamble);
    return {
      run: vi.fn(async (code: string): Promise<RunResult> => {
        const logs: string[] = [];
        try {
          const evaluate = new Function("console", `${options.preamble}\nreturn (async () => { ${code} })();`);
          return { ok: true, data: await evaluate({ log: (...args: unknown[]) => logs.push(args.join(" ")) }), logs };
        } catch (err) {
          return { ok: false, error: { name: (err as Error).name, message: (err as Error).message, line: 1 }, logs };
        }
      }),
    };
  });
  return { store, client, auth, sandbox, index, indexSandbox, preambles };
}

async function connect(d: ReturnType<typeof deps>) {
  const server = createServer({
    store: d.store as never,
    client: d.client as never,
    auth: d.auth as never,
    sandbox: d.sandbox,
    index: d.index,
    indexSandbox: d.indexSandbox,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

describe("search", () => {
  it("is registered as a local read-only tool that takes only code (#78)", async () => {
    const d = deps();
    const mcp = await connect(d);
    const tool = (await mcp.listTools()).tools.find((candidate) => candidate.name === "search");

    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort()).toEqual(["cloud", "code"]);
    expect(SEARCH_DESCRIPTION.length).toBeLessThan(2_400);
    expect(d.index).not.toHaveBeenCalled();
    expect(d.indexSandbox).not.toHaveBeenCalled();
  });

  it("refuses a call with no code, such as the old query argument (#78)", async () => {
    const mcp = await connect(deps());
    const response = await mcp.callTool({ name: "search", arguments: { query: "user" } });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("code");
  });

  it("runs the description's examples against the shipped index", async () => {
    const mcp = await connect(deps());
    const run = async (code: string) =>
      (await mcp.callTool({ name: "search", arguments: { code } })).structuredContent as { ok: boolean; result: unknown };

    const least = await run('return index.paths["/identity/conditionalAccess/policies"]?.scopes?.get?.delegated;');
    expect(least).toMatchObject({ ok: true, result: { least: ["Policy.Read.All"] } });
    const paths = await run('return Object.keys(index.paths).filter((p) => p.toLowerCase().includes("conditionalaccess")).length;');
    expect(paths.result).toBeGreaterThan(10);
  });

  it("loads the GCC High catalogue when that cloud is requested", async () => {
    const d = deps();
    const mcp = await connect(d);
    await mcp.callTool({ name: "search", arguments: { code: "return 1;", cloud: "usgov-high" } });

    expect(d.index).toHaveBeenCalledWith("usgov-high");
  });
});

describe("search: an index run", () => {
  const call = (mcp: Awaited<ReturnType<typeof connect>>, code: string) =>
    mcp.callTool({ name: "search", arguments: { code } });

  it("runs a script against the shipped index and returns what it returns", async () => {
    const d = deps();
    const mcp = await connect(d);
    const response = await call(mcp, 'return Object.keys(index.paths).filter((p) => p.startsWith("/security")).length;');
    const structured = response.structuredContent as { ok: boolean; result: number; truncated: boolean };

    expect(structured).toMatchObject({ ok: true, truncated: false });
    expect(structured.result).toBeGreaterThan(0);
  });

  it("needs no connection and no tenant argument", async () => {
    const d = deps();
    // `store.resolve` returns undefined for every alias here: no connection is registered.
    const mcp = await connect(d);
    const response = await call(mcp, "return index.version;");

    expect(response.isError).toBeFalsy();
    expect((response.structuredContent as { result: string }).result).toBe("v1.0");
    expect(d.store.resolve).not.toHaveBeenCalled();
    for (const graphCall of Object.values(d.client)) expect(graphCall).not.toHaveBeenCalled();
  });

  it("builds the index sandbox once, on the first index run and not before", async () => {
    const d = deps();
    const mcp = await connect(d);

    await mcp.callTool({ name: "search", arguments: { query: "user" } });
    expect(d.indexSandbox).not.toHaveBeenCalled();

    await call(mcp, "return 1;");
    await call(mcp, "return 2;");
    expect(d.indexSandbox).toHaveBeenCalledTimes(1);
  });

  it("puts the whole index in scope as `index`, placed as a literal rather than parsed", async () => {
    const d = deps();
    const mcp = await connect(d);
    await call(mcp, "return 1;");

    expect(d.preambles).toHaveLength(1);
    expect(d.preambles[0]).toBe(`const index = ${loaded.text};`);
    expect(d.preambles[0]).not.toContain("JSON.parse");
  });

  it("returns a script error with its message and anything logged before it failed", async () => {
    const mcp = await connect(deps());
    const response = await call(mcp, "console.log('got here'); throw new Error('boom');");
    const structured = response.structuredContent as { ok: boolean; error: { message: string; line: number }; logs: string[] };

    expect(structured.ok).toBe(false);
    expect(structured.error.message).toContain("boom");
    expect(structured.error.line).toBe(1);
    expect(structured.logs).toEqual(["got here"]);
  });

  it("caps the output and flags it, the same way a run's result is", async () => {
    const mcp = await connect(deps());
    const response = await call(mcp, "return Object.keys(index.paths);");
    const structured = response.structuredContent as { truncated: boolean; result: unknown };

    expect(structured.truncated).toBe(true);
    expect(typeof structured.result).toBe("string");
    expect(capJson(structured).text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS + 200);
    expect((response.content as Array<{ text: string }>)[0].text).toContain(INDEX_TRUNCATION_NOTE);
  });
});
