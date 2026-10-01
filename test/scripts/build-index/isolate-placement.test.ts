/**
 * The index has to survive the trip into a `workerd` isolate at full size, because
 * `search` places it there as an object literal.
 *
 * `workerd` refuses a dynamic worker whose module source exceeds MAX_DYNAMIC_WORKER_CODE_SIZE,
 * a constant compiled into the binary at 67,108,864 bytes. Measured usable budget is 63 MB as
 * a literal and 57 MB through JSON.parse; the literal wins because escaping the JSON into a
 * string inflates the source about 1.16x. This test loads data/graph-index.json rather than a
 * fixture, so it is the shipped file that is proven to fit.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Miniflare, NoOpLog } from "miniflare";

const HOST_WORKER = `
export default {
  async fetch(request, env) {
    const indexText = await request.text();
    const script = atob(request.headers.get("x-script"));
    const worker = env.LOADER.get(request.headers.get("x-id"), () => ({
      compatibilityDate: "2026-01-12",
      globalOutbound: null,
      mainModule: "index.js",
      modules: {
        "index.js": [
          'import { WorkerEntrypoint } from "cloudflare:workers";',
          "const index = " + indexText + ";",
          "export default class extends WorkerEntrypoint {",
          "  async evaluate() { return await (async () => { " + script + " })(); }",
          "}",
        ].join("\\n"),
      },
    }));
    const value = await worker.getEntrypoint().evaluate();
    return Response.json({ value });
  },
};
`;

const indexText = readFileSync(resolve(process.cwd(), "data/graph-index.json"), "utf8");

const miniflare = new Miniflare({
  modules: true,
  compatibilityDate: "2026-01-12",
  script: HOST_WORKER,
  workerLoaders: { LOADER: {} },
  log: new NoOpLog(),
});

afterAll(async () => {
  await miniflare.dispose();
});

async function inIsolate(script: string): Promise<unknown> {
  const response = await miniflare.dispatchFetch("http://index.local/", {
    method: "POST",
    headers: { "x-script": Buffer.from(script).toString("base64"), "x-id": `index-${Math.random().toString(36).slice(2)}` },
    body: indexText,
  });
  const body = (await response.json()) as { value?: unknown };
  return body.value;
}

describe("the shipped index inside a workerd isolate", () => {
  it("places as an object literal and a script can count its paths", async () => {
    await expect(inIsolate("return Object.keys(index.paths).length")).resolves.toBeGreaterThan(10_000);
  });

  it("answers a question a search could not phrase, over the shared types table", async () => {
    const answer = await inIsolate(`
      const entity = index.paths["/users"].entityType;
      return Object.keys(index.types[entity].properties).length;
    `);

    expect(answer).toBeGreaterThan(100);
  });

  it("carries the scopes and the consistency flag through the placement unchanged", async () => {
    const answer = await inIsolate(`
      const users = index.paths["/users"];
      return { consistency: users.consistency, least: users.scopes.get.delegated.least.length };
    `);

    expect(answer).toMatchObject({ consistency: true });
    expect((answer as { least: number }).least).toBeGreaterThan(0);
  });
});
