import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { GraphIndex } from "../../../src/core/index/graph-index.js";
import { createIndexLoader, loadGraphIndex } from "../../../src/core/index/loader.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const fixture: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: { "microsoft.graph.user": { properties: { id: "Edm.String" } } },
  enums: {},
  paths: { "/users": { methods: ["get"], entityType: "microsoft.graph.user" } },
};

describe("loadGraphIndex", () => {
  it("loads an index file and reports the work it did", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");
    const json = JSON.stringify(fixture);

    try {
      await writeFile(file, json);

      const loaded = await loadGraphIndex(file);

      expect(loaded.index).toEqual(fixture);
      expect(loaded.bytes).toBe(Buffer.byteLength(json));
      expect(loaded.loadMs).toBeGreaterThanOrEqual(0);
      // An index run places the source as an object literal rather than parsing it inside the
      // isolate, so the loader keeps the text it read as well as the value it parsed.
      expect(loaded.text).toBe(json);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes paths absent from GCC High from both the parsed index and the index-run source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");
    const removalsFile = join(directory, "fixture.usgov.removals.json");
    const withCommercialOnlyPath: GraphIndex = {
      ...fixture,
      paths: {
        ...fixture.paths,
        "/commercialOnly": { methods: ["get"] },
      },
    };

    try {
      await writeFile(file, JSON.stringify(withCommercialOnlyPath));
      await writeFile(removalsFile, JSON.stringify(["/commercialOnly"]));

      const loaded = await loadGraphIndex(file, { cloud: "usgov-high", removalsFile });

      expect(loaded.index.paths).toEqual(fixture.paths);
      expect(JSON.parse(loaded.text)).toEqual(loaded.index);
      expect(loaded.bytes).toBe(Buffer.byteLength(loaded.text));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads the index only once for repeated calls through one loader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");

    try {
      await writeFile(file, JSON.stringify(fixture));
      vi.mocked(readFile).mockClear();
      const load = createIndexLoader(file);

      await load();
      await load();

      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("memoises a separate catalogue for each cloud", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");
    const removalsFile = join(directory, "fixture.usgov.removals.json");
    const withCommercialOnlyPath: GraphIndex = {
      ...fixture,
      paths: { ...fixture.paths, "/commercialOnly": { methods: ["get"] } },
    };

    try {
      await writeFile(file, JSON.stringify(withCommercialOnlyPath));
      await writeFile(removalsFile, JSON.stringify(["/commercialOnly"]));
      const load = createIndexLoader(file, { removalsFile });

      const commercial = await load("commercial");
      const gov = await load("usgov-high");

      expect(commercial.index.paths).toHaveProperty("/commercialOnly");
      expect(gov.index.paths).not.toHaveProperty("/commercialOnly");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one read between concurrent callers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");

    try {
      await writeFile(file, JSON.stringify(fixture));
      vi.mocked(readFile).mockClear();
      const load = createIndexLoader(file);

      await Promise.all([load(), load()]);

      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries after a load fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "graph-index-loader-"));
    const file = join(directory, "fixture.json");
    const load = createIndexLoader(file);

    try {
      await expect(load()).rejects.toThrow();
      await writeFile(file, JSON.stringify(fixture));

      await expect(load()).resolves.toMatchObject({ index: fixture });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads the packaged v1.0 index by default", async () => {
    const loaded = await loadGraphIndex();

    console.log(`graph index load: ${loaded.loadMs.toFixed(2)} ms, ${loaded.bytes} bytes`);
    expect(loaded.index.version).toBe("v1.0");
    expect(Object.keys(loaded.index.paths).length).toBeGreaterThan(0);
    expect(Object.keys(loaded.index.types).length).toBeGreaterThan(0);
  });
});
