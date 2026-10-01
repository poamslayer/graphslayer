import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { literalPathDepth, rankReadScopes } from "../../scripts/rank-read-scopes.ts";
import type { GraphIndex, PathEntry } from "../../src/core/index/graph-index.ts";

function path(scopes: PathEntry["scopes"]): PathEntry {
  return { methods: Object.keys(scopes ?? {}), scopes };
}

const fixture: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: {},
  enums: {},
  paths: {
    "/one": path({
      get: {
        delegated: {
          least: ["One.Read.All"],
          all: ["One.Read.All", "AllOnly.Read.All", "One.ReadWrite.All"],
        },
        application: { all: ["ApplicationOnly.Read.All"] },
      },
    }),
    "/one/two": path({
      get: { delegated: { all: ["Fallback.Read.All", "One.Read.All"] } },
    }),
    "/one/{item-id}/two/three/four/five/six": path({
      get: { delegated: { least: ["Deep.Read.All"], all: ["Deep.Read.All"] } },
    }),
    "/postOnly": path({
      post: { delegated: { all: ["PostOnly.Read.All"] } },
    }),
  },
};

const ranking = rankReadScopes(fixture);

describe("rankReadScopes", () => {
  it("ranks delegated GET scopes using least when present and all as the fallback", () => {
    expect(ranking.find(({ scope }) => scope === "One.Read.All")).toMatchObject({
      rank: 1,
      totalPaths: 2,
      shallowPaths: 2,
      deepPaths: 0,
      leastPrivilegedPaths: 1,
      allPaths: 2,
    });
    expect(ranking.find(({ scope }) => scope === "Fallback.Read.All")).toMatchObject({
      totalPaths: 1,
      leastPrivilegedPaths: 0,
      allPaths: 1,
    });
  });

  it("keeps a scope that appears only in all while giving it no effective or least paths", () => {
    expect(ranking.find(({ scope }) => scope === "AllOnly.Read.All")).toMatchObject({
      totalPaths: 0,
      leastPrivilegedPaths: 0,
      allPaths: 1,
    });
  });

  it("excludes application-only scopes and non-GET methods", () => {
    expect(ranking.map(({ scope }) => scope)).not.toContain("ApplicationOnly.Read.All");
    expect(ranking.map(({ scope }) => scope)).not.toContain("PostOnly.Read.All");
  });

  it("buckets paths at one, two, and six literal segments", () => {
    expect(literalPathDepth("/one")).toBe(1);
    expect(literalPathDepth("/one/two")).toBe(2);
    expect(literalPathDepth("/one/{item-id}/two/three/four/five/six")).toBe(6);
    expect(ranking.find(({ scope }) => scope === "Deep.Read.All")).toMatchObject({
      totalPaths: 1,
      shallowPaths: 0,
      deepPaths: 1,
    });
  });

  it("drops write scopes from the output", () => {
    expect(ranking.map(({ scope }) => scope)).not.toContain("One.ReadWrite.All");
  });
});

/**
 * The sort key is shallow coverage, not total coverage, and the two disagree. Depth 6 and
 * deeper is 1,956 of the index's 6,558 real GET reads, so a scope that wins on totals can have
 * won them all somewhere nobody calls. This fixture makes them disagree on purpose.
 */
describe("rankReadScopes ordering", () => {
  const depthFixture: GraphIndex = {
    version: "v1.0",
    builtAt: "2026-09-16",
    types: {},
    enums: {},
    paths: {
      "/shallow": path({ get: { delegated: { least: ["Shallow.Read.All"], all: ["Shallow.Read.All"] } } }),
      "/a/{id}/b/c/d/e": path({ get: { delegated: { least: ["Deep.Read.All"], all: ["Deep.Read.All"] } } }),
      "/a/{id}/b/c/d/f": path({ get: { delegated: { least: ["Deep.Read.All"], all: ["Deep.Read.All"] } } }),
      "/a/{id}/b/c/d/g": path({ get: { delegated: { least: ["Deep.Read.All"], all: ["Deep.Read.All"] } } }),
    },
  };

  it("puts one shallow path ahead of three deep ones", () => {
    const ranking = rankReadScopes(depthFixture);

    expect(ranking.map(({ scope, rank }) => [scope, rank])).toEqual([
      ["Shallow.Read.All", 1],
      ["Deep.Read.All", 2],
    ]);
    expect(ranking[1]).toMatchObject({ totalPaths: 3, shallowPaths: 0, deepPaths: 3 });
  });

  it("ranks the whole fixture in shallow-coverage order, ties broken by name", () => {
    expect(rankReadScopes(fixture).map(({ scope }) => scope)).toEqual([
      "One.Read.All",
      "Fallback.Read.All",
      "Deep.Read.All",
      "AllOnly.Read.All",
    ]);
  });

  it("buckets the all column by depth too, so a sufficient-but-never-minimum scope is still visible", () => {
    // AllOnly.Read.All scores zero on the sort key and would vanish without this column.
    expect(ranking.find(({ scope }) => scope === "AllOnly.Read.All")).toMatchObject({
      shallowPaths: 0,
      allPaths: 1,
      allShallowPaths: 1,
    });
    expect(ranking.find(({ scope }) => scope === "Deep.Read.All")).toMatchObject({
      allPaths: 1,
      allShallowPaths: 0,
    });
  });
});

/**
 * The reason `build-index/build.ts` carries the same guard: reaching for an export must never
 * rewrite the artifacts the run produces, or `npm test` leaves the working tree dirty and a
 * test that asserts on the ranking asserts on something this import just overwrote.
 */
describe("importing the ranking module", () => {
  it("does not run the ranking", async () => {
    const output = resolve(process.cwd(), "data/read-scope-ranking.json");
    const before = existsSync(output) ? readFileSync(output, "utf8") : null;

    await import("../../scripts/rank-read-scopes.ts");

    expect(existsSync(output) ? readFileSync(output, "utf8") : null).toBe(before);
  });
});
