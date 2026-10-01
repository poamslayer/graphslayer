/**
 * `search` against the real thing: the real `MiniflareSandbox`, the real
 * `workerd`, and the real shipped `data/graph-index.json` at full size. The tests in
 * `test/core/tools/search.test.ts` cover the tool's contract with a stand-in sandbox;
 * these cover what only the runtime can answer — that the index places at full size, that the
 * isolate has no way out, and that the deadline holds.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";

import { loadGraphIndex } from "../../../src/core/index/loader.js";
import { createServer } from "../../../src/core/server.js";
import { buildDeps } from "../../../src/transport/stdio/main.js";
import { MiniflareSandbox } from "../../../src/transport/stdio/miniflare-sandbox.js";

const built: MiniflareSandbox[] = [];
/** No connection is registered anywhere in this file: an index run must not need one. */
const store = { list: async () => [], resolve: vi.fn(async () => undefined), upsert: async () => {}, remove: async () => false };

function serverWith(options: { timeoutMs?: number } = {}) {
  const server = createServer({
    store: store as never,
    client: {} as never,
    auth: {} as never,
    sandbox: { run: async () => { throw new Error("no execute in this test"); } },
    indexSandbox: ({ preamble }) => {
      const sandbox = new MiniflareSandbox({ graphServiceBinding: false, preamble, timeoutMs: options.timeoutMs ?? 30_000 });
      built.push(sandbox);
      return sandbox;
    },
  });
  return server;
}

async function clientFor(options: { timeoutMs?: number } = {}) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await serverWith(options).connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

const shared = await clientFor();

afterAll(async () => {
  await Promise.all(built.map((sandbox) => sandbox.dispose()));
});

type IndexRun = { ok: boolean; result?: unknown; error?: { name: string; message: string; line?: number }; logs: string[]; truncated: boolean };

async function run(code: string, mcp = shared): Promise<IndexRun> {
  const response = await mcp.callTool({ name: "search", arguments: { code } });
  expect(response.isError).toBeFalsy();
  return response.structuredContent as IndexRun;
}

describe("an index run against the shipped index", () => {
  it("reads the full-size index and answers a question a query could not phrase", async () => {
    // "How many paths under /security support DELETE" is one line of JavaScript and no search.
    const answer = await run(
      'return Object.entries(index.paths).filter(([p, e]) => p.startsWith("/security") && e.methods.includes("delete")).length;',
    );

    expect(answer).toMatchObject({ ok: true, truncated: false });
    expect(answer.result).toBeGreaterThan(0);
  });

  it("sees the whole index, not a fixture-sized piece of it", async () => {
    const { index } = await loadGraphIndex();
    const counted = await run("return { paths: Object.keys(index.paths).length, types: Object.keys(index.types).length };");

    expect(counted.result).toEqual({
      paths: Object.keys(index.paths).length,
      types: Object.keys(index.types).length,
    });
    expect((counted.result as { paths: number }).paths).toBeGreaterThan(10_000);
  });

  it("joins the paths table to the shared types table, which is why the index is one object", async () => {
    const answer = await run(`
      const withDate = Object.entries(index.types)
        .filter(([, t]) => Object.values(t.properties).some((type) => type === "Edm.DateTimeOffset"));
      return withDate.length;
    `);

    expect(answer.result).toBeGreaterThan(100);
  });

  it("needs no connection and no tenant argument", async () => {
    expect((await run("return index.version;")).result).toBe("v1.0");
    expect(store.resolve).not.toHaveBeenCalled();
  });
});

describe("an index run has no way out of the isolate", () => {
  it.each([
    ["the binding host", "https://graph.local/get"],
    ["another hostname", "https://example.com"],
    ["an IP", "http://127.0.0.1:1/"],
  ])("cannot reach %s", async (_what, url) => {
    const attempt = await run(
      `try { const res = await fetch(${JSON.stringify(url)}); return { reached: res.status }; } catch (e) { return { failed: e.message }; }`,
    );

    expect(attempt.result).toMatchObject({ failed: expect.stringContaining("not permitted to access the internet") });
  });

  it.each([
    ["the filesystem", "const m = await import('node:fs'); return m.readFileSync('/etc/hosts', 'utf8');"],
    ["the environment", "return env.GRAPH;"],
    ["process", "return process.env.HOME;"],
    ["require", "return require('node:os').homedir();"],
  ])("fails inside the isolate when a script reaches for %s", async (_what, code) => {
    // Absent globals are not enough on their own: the criterion is that the attempt fails, so
    // each script here uses what it reaches for rather than only asking whether it is there.
    const attempt = await run(`try { ${code} } catch (e) { return { failed: e.name + ": " + e.message }; }`);

    expect(attempt.ok).toBe(true);
    expect(attempt.result).toMatchObject({ failed: expect.any(String) });
  });

  it("does not carry the globals a Node process would", async () => {
    const globals = await run("return { process: typeof process, require: typeof require, env: typeof env, Deno: typeof Deno };");
    expect(globals.result).toEqual({ process: "undefined", require: "undefined", env: "undefined", Deno: "undefined" });
  });
});

describe("an index run is bounded like a run", () => {
  it("is stopped at the deadline, and the next index run still works", async () => {
    const mcp = await clientFor({ timeoutMs: 2_000 });

    const wedged = await run("while (true) {}", mcp);
    expect(wedged).toMatchObject({ ok: false });
    expect(wedged.error?.name).toBe("TimeoutError");

    // The driver threw the runtime away and rebuilt it, index preamble and all.
    expect((await run("return Object.keys(index.paths).length;", mcp)).result).toBeGreaterThan(10_000);
  });

  it("returns the failing line of the script, its message, and what it logged first", async () => {
    const failed = await run("const paths = Object.keys(index.paths);\nconsole.log('counted', paths.length);\nthrow new Error('boom');");

    expect(failed.ok).toBe(false);
    expect(failed.error?.message).toContain("boom");
    expect(failed.error?.line).toBe(3);
    expect(failed.logs[0]).toMatch(/^counted \d+$/);
  });

  it("caps a script that returns too much and flags it", async () => {
    const everything = await run("return index.paths;");

    expect(everything.truncated).toBe(true);
    expect(typeof everything.result).toBe("string");
    expect(JSON.stringify(everything).length).toBeLessThan(45_000);
  });
});

/**
 * What an index run costs. The numbers are printed rather than asserted tightly, so
 * `docs/measurements/` can be re-measured rather than trusted. The bounds catch a regression
 * that changes the order of magnitude.
 */
describe("what an index run costs", () => {
  it("measures the first run, a warm run, and what comes back", async () => {
    const mcp = await clientFor();
    const time = async (code: string) => {
      const started = performance.now();
      const result = await run(code, mcp);
      return { ms: performance.now() - started, chars: JSON.stringify(result).length };
    };

    const first = await time("return Object.keys(index.paths).length;");
    const warm = await time("return Object.keys(index.types).length;");
    const heavy = await time('return Object.keys(index.paths).filter((p) => p.startsWith("/users")).slice(0, 50);');

    console.log(
      `index run: first ${first.ms.toFixed(0)} ms (workerd start + index placement), ` +
        `warm ${warm.ms.toFixed(0)} ms, 50 paths returned ${heavy.chars} characters in ${heavy.ms.toFixed(0)} ms`,
    );
    expect(first.ms).toBeLessThan(20_000);
    expect(warm.ms).toBeLessThan(10_000);
    expect(heavy.chars).toBeLessThan(5_000);
  });
});

/**
 * The no-network guarantee rests on one flag in `buildDeps`. Everything above builds its own
 * sandbox with that flag set, which proves the sandbox and not the wiring, so this exercises the
 * factory the shipped server actually hands to `search`.
 */
describe("the index sandbox the server is built with", () => {
  it("is built without the Graph service binding, so a script has no network", async () => {
    const home = await mkdtemp(join(tmpdir(), "graphslayer-deps-"));
    const previous = { home: process.env.GRAPHSLAYER_HOME, cache: process.env.GRAPHSLAYER_NO_TOKEN_CACHE };
    process.env.GRAPHSLAYER_HOME = home;
    // Keep the real keychain out of a test run.
    process.env.GRAPHSLAYER_NO_TOKEN_CACHE = "1";

    const deps = await buildDeps();
    try {
      const sandbox = deps.indexSandbox({ preamble: "const index = { version: 'v1.0' };" });
      const attempt = await sandbox.run("try { await fetch('https://graph.local/get'); return 'reached'; } catch (e) { return e.message; }");

      expect(attempt.data).toContain("not permitted to access the internet");
      // The same factory twice is the same sandbox, so a second index run does not start a
      // second `workerd`.
      expect(deps.indexSandbox({ preamble: "const index = {};" })).toBe(sandbox);
    } finally {
      await deps.dispose();
      process.env.GRAPHSLAYER_HOME = previous.home;
      process.env.GRAPHSLAYER_NO_TOKEN_CACHE = previous.cache;
      await rm(home, { recursive: true, force: true });
    }
  });
});
