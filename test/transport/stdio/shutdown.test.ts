/**
 * What only a real process can answer: that the published bin starts, speaks MCP over stdio,
 * and leaves no `workerd` behind when it is killed.
 *
 * Every other test in this repo drives the server in process, which cannot see a child runtime
 * outliving its parent. That is the failure this file exists for: `workerd` is a separate
 * executable Miniflare spawns, and a server that exits without disposing it leaves a process
 * holding memory on the person's machine for as long as they stay logged in.
 *
 * It runs against `dist/`, because the thing being tested is what a person actually installs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = resolve("dist/cli/main.js");
const built = existsSync(BIN);

/** Every descendant pid of a process, depth first, so a grandchild runtime is not missed. */
async function descendants(pid: number): Promise<number[]> {
  const found: number[] = [];
  const walk = async (parent: number) => {
    const children = await run("pgrep", ["-P", String(parent)]).then(
      ({ stdout }) => stdout.split("\n").map((line) => Number(line.trim())).filter(Boolean),
      // pgrep exits 1 when nothing matches, which is the common case, not an error.
      () => [] as number[],
    );
    for (const child of children) {
      found.push(child);
      await walk(child);
    }
  };
  await walk(pid);
  return found;
}

async function workerdUnder(pid: number): Promise<number[]> {
  const pids = await descendants(pid);
  if (pids.length === 0) return [];
  const { stdout } = await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")]).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .filter((line) => line.includes("workerd"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Boolean);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(what: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await what();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One JSON-RPC exchange over the child's stdio, resolved by matching the request id. */
function rpc(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const waiting = new Map<number, (value: unknown) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  return {
    send(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
      const sent = new Promise<Record<string, unknown>>((r) => waiting.set(id, r as (v: unknown) => void));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return sent;
    },
    notify(method: string, params: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

describe.skipIf(!built)("the published bin over stdio", () => {
  let home: string;
  let child: ChildProcessWithoutNullStreams;
  let calls: ReturnType<typeof rpc>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "graphslayer-shutdown-"));
    child = spawn(process.execPath, [BIN], {
      env: { ...process.env, GRAPHSLAYER_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    calls = rpc(child);
    await calls.send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "shutdown-test", version: "0.0.0" },
    });
    calls.notify("notifications/initialized", {});
  }, 60_000);

  afterAll(async () => {
    if (child && !child.killed) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  });

  it("lists the tools the README says it has, which is what pasting the install block buys", async () => {
    const response = await calls.send(2, "tools/list", {});
    const names = ((response.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();

    expect(names).toEqual([
      "connection_add", "connection_remove", "connections_list", "docs", "execute", "search",
    ]);
  }, 30_000);

  it("has not started workerd merely by being connected to", async () => {
    expect(await workerdUnder(child.pid!)).toEqual([]);
  }, 30_000);

  /**
   * Honest about what this proves. Removing the server's own `deps.dispose()` does not make it
   * fail, because Miniflare registers a `process.on("exit")` hook of its own and any path that
   * reaches a normal exit cleans up through that. What it does prove is the criterion itself,
   * and it would catch a change that exits without reaching either hook, or one that spawned
   * the runtime detached.
   *
   * The leak is real and worth guarding: probed on the built server, `workerd` survives a
   * SIGKILL of its parent, because nothing can run on SIGKILL. That case cannot be fixed in
   * this process and is documented in the README rather than tested here.
   */
  it("starts workerd for an index run, then leaves none behind on SIGTERM", async () => {
    // An index run is the cheapest thing that builds a sandbox: no connection, no Graph call.
    const response = await calls.send(3, "tools/call", {
      name: "search",
      arguments: { code: "return Object.keys(index.paths).length;" },
    });
    expect((response.result as { isError?: boolean }).isError).toBeFalsy();

    const running = await until(() => workerdUnder(child.pid!), (found) => found.length > 0);
    expect(running.length).toBeGreaterThan(0);

    child.kill("SIGTERM");

    await until(async () => alive(child.pid!), (isAlive) => !isAlive);
    expect(alive(child.pid!)).toBe(false);

    // The runtime is a separate executable, so it survives its parent unless disposed.
    const leftovers = await until(
      async () => running.filter(alive),
      (found) => found.length === 0,
    );
    expect(leftovers).toEqual([]);
  }, 120_000);
});

describe.skipIf(!built)("a client that goes away without killing the server", () => {
  it("exits and takes workerd with it when stdin closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "graphslayer-eof-"));
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, GRAPHSLAYER_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const calls = rpc(child);
    await calls.send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "eof-test", version: "0.0.0" },
    });
    calls.notify("notifications/initialized", {});
    await calls.send(2, "tools/call", {
      name: "search",
      arguments: { code: "return Object.keys(index.paths).length;" },
    });

    const running = await until(() => workerdUnder(child.pid!), (found) => found.length > 0);
    expect(running.length).toBeGreaterThan(0);

    // No signal. The client simply stops talking, which is what a client that crashes or is
    // closed does. `StdioServerTransport` listens for `data` and `error` on stdin and nothing
    // else, so without the server's own `end` handler this hangs forever holding the runtime.
    child.stdin.end();

    await until(async () => alive(child.pid!), (isAlive) => !isAlive);
    expect(alive(child.pid!), "the server should exit when its client goes away").toBe(false);
    expect(running.filter(alive)).toEqual([]);

    if (!child.killed) child.kill("SIGKILL");
    for (const pid of running) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await rm(home, { recursive: true, force: true });
  }, 120_000);
});

describe.skipIf(!built)("the CLI commands", () => {
  it("lists connections without ever starting workerd", async () => {
    const home = await mkdtemp(join(tmpdir(), "graphslayer-cli-"));
    const child = spawn(process.execPath, [BIN, "connections"], {
      env: { ...process.env, GRAPHSLAYER_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // `connections` runs buildDeps and exits, which is the same path `connect` takes up to the
    // browser. If constructing the deps started the runtime, it would appear here.
    const seen: number[] = [];
    const poll = setInterval(() => void workerdUnder(child.pid!).then((found) => seen.push(...found)), 50);
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    clearInterval(poll);

    expect(code).toBe(0);
    expect(seen).toEqual([]);
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});
