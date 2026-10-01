import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { convertYamlToJson, ensureSources, hasYamlConverter, SOURCES, sourcesToFetch } from "../../../scripts/build-index/sources.ts";

describe("SOURCES", () => {
  it("caches the live GCC High CSDL for both Graph versions", () => {
    expect(SOURCES.filter(({ name }) => name.startsWith("csdl-usgov-"))).toEqual([
      { name: "csdl-usgov-v1.0.xml", url: "https://graph.microsoft.us/v1.0/$metadata" },
      { name: "csdl-usgov-beta.xml", url: "https://graph.microsoft.us/beta/$metadata" },
    ]);
  });
});

describe("sourcesToFetch when refreshing", () => {
  it("asks for every source again, so a release is not built from a stale cache", () => {
    const present = new Map([["csdl-v1.0.xml", 3_592_653], ["permissions.json", 3_066_547]]);

    expect(sourcesToFetch(SOURCES, present, { refresh: true })).toHaveLength(SOURCES.length);
  });
});

describe("sourcesToFetch", () => {
  it("asks for the sources that are not in the cache yet", () => {
    const present = new Map([["csdl-v1.0.xml", 3_592_653]]);

    expect(sourcesToFetch(SOURCES, present).map((source) => source.name)).not.toContain("csdl-v1.0.xml");
    expect(sourcesToFetch(SOURCES, present).map((source) => source.name)).toContain("permissions.json");
  });

  it("asks again for a cached file that is empty, because a half-written download is worse than none", () => {
    const present = new Map([["csdl-v1.0.xml", 0]]);

    expect(sourcesToFetch(SOURCES, present).map((source) => source.name)).toContain("csdl-v1.0.xml");
  });
});

describe("convertYamlToJson", () => {
  it.skipIf(!hasYamlConverter())(
    "converts a YAML document to JSON, because Node cannot parse the 44 MB one at all",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "graph-index-"));
      const yamlPath = join(directory, "small.yaml");
      const jsonPath = join(directory, "small.json");
      writeFileSync(yamlPath, "openapi: 3.0.1\npaths:\n  /users:\n    get:\n      responses:\n        '2XX':\n          description: ok\n");

      convertYamlToJson(yamlPath, jsonPath);

      expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual({
        openapi: "3.0.1",
        paths: { "/users": { get: { responses: { "2XX": { description: "ok" } } } } },
      });
    },
  );
});

describe("ensureSources when refreshing", () => {
  it("replaces the cached sources and reconverts the YAML, rather than reusing yesterday's metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-index-"));
    writeFileSync(join(directory, "openapi-v1.0.yaml"), "openapi: 3.0.1\npaths: {}\n");
    writeFileSync(join(directory, "openapi-v1.0.json"), '{"openapi":"stale"}');
    const asked: string[] = [];

    await ensureSources(directory, {
      refresh: true,
      sources: [{ name: "openapi-v1.0.yaml", url: "https://example.invalid/openapi" }],
      converterAvailable: () => true,
      download: async (source, destination) => {
        asked.push(source.name);
        writeFileSync(destination, "openapi: 3.0.1\npaths:\n  /fresh: {}\n");
      },
    });

    expect(asked).toEqual(["openapi-v1.0.yaml"]);
    expect(JSON.parse(readFileSync(join(directory, "openapi-v1.0.json"), "utf8"))).toEqual({
      openapi: "3.0.1",
      paths: { "/fresh": {} },
    });
  });
});

describe("ensureSources", () => {
  it("downloads what the cache is missing and leaves what it already has alone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-index-"));
    writeFileSync(join(directory, "permissions.json"), '{"permissions":{}}');
    const asked: string[] = [];

    await ensureSources(directory, {
      sources: [
        SOURCES.find(({ name }) => name === "permissions.json")!,
        { name: "csdl-v1.0.xml", url: "https://example.invalid/csdl" },
      ],
      download: async (source, destination) => {
        asked.push(source.name);
        writeFileSync(destination, "<Edmx />");
      },
    });

    expect(asked).toEqual(["csdl-v1.0.xml"]);
    expect(readFileSync(join(directory, "permissions.json"), "utf8")).toBe('{"permissions":{}}');
  });

  it.skipIf(!hasYamlConverter())("converts a downloaded YAML source to the JSON the build reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-index-"));

    await ensureSources(directory, {
      sources: [{ name: "openapi-v1.0.yaml", url: "https://example.invalid/openapi" }],
      download: async (_source, destination) => {
        writeFileSync(destination, "openapi: 3.0.1\npaths: {}\n");
      },
    });

    expect(JSON.parse(readFileSync(join(directory, "openapi-v1.0.json"), "utf8"))).toEqual({ openapi: "3.0.1", paths: {} });
  });
});

describe("ensureSources on a machine with no YAML converter", () => {
  it("says what to install before spending a 130 MB download on a build that cannot finish", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-index-"));
    const asked: string[] = [];

    await expect(
      ensureSources(directory, {
        sources: [{ name: "openapi-v1.0.yaml", url: "https://example.invalid/openapi" }],
        converterAvailable: () => false,
        download: async (source) => {
          asked.push(source.name);
        },
      }),
    ).rejects.toThrow(/PyYAML/);

    expect(asked).toEqual([]);
  });

  it("needs no converter when the JSON is already cached", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graph-index-"));
    writeFileSync(join(directory, "openapi-v1.0.yaml"), "openapi: 3.0.1\n");
    writeFileSync(join(directory, "openapi-v1.0.json"), '{"openapi":"3.0.1"}');

    await expect(
      ensureSources(directory, {
        sources: [{ name: "openapi-v1.0.yaml", url: "https://example.invalid/openapi" }],
        converterAvailable: () => false,
        download: async () => {
          throw new Error("nothing should be downloaded");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
