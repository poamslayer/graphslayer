import { describe, expect, it, vi } from "vitest";

import type { GraphIndex } from "../../../src/core/index/graph-index.js";
import { createIndexPaths, indexPaths } from "../../../src/core/index/paths.js";
import { loadGraphIndex } from "../../../src/core/index/loader.js";
import type { LoadedIndex } from "../../../src/core/index/loader.js";

const fixture: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: {},
  enums: {},
  paths: {
    "/users": { methods: ["get", "post"], consistency: true },
    "/users/delta": { methods: ["get"] },
    "/users/{user-id}": { methods: ["get", "patch"] },
    "/users/{user-id}/messages": { methods: ["get"] },
    "/users/{user-id}/memberOf": { methods: ["get"], consistency: true },
    "/groups/{group-id}/members": { methods: ["get"], consistency: true },
    "/groups/{group-id}/members/$count": { methods: ["get"] },
    "/directoryRoles": { methods: ["get"] },
    "/admin/edge/internetExplorerMode/siteLists": { methods: ["get"] },
  },
};

const paths = indexPaths(fixture);

describe("indexPaths.match", () => {
  it("resolves a path that needs no placeholder", () => {
    expect(paths.match("/users")).toBe("/users");
  });

  it("resolves real ids onto the placeholders that stand for them", () => {
    expect(paths.match("/users/abc-123")).toBe("/users/{user-id}");
    expect(paths.match("/groups/abc-123/members")).toBe("/groups/{group-id}/members");
  });

  it("resolves a user principal name, which is an id that looks like a word", () => {
    expect(paths.match("/users/admin@contoso.com/messages")).toBe("/users/{user-id}/messages");
  });

  it("prefers a literal segment over the placeholder that would also take it", () => {
    expect(paths.match("/users/delta")).toBe("/users/delta");
  });

  it("falls back to the placeholder when the literal branch dead ends", () => {
    // "/users/delta" exists but has no "messages" under it, so "delta" here is an id.
    expect(paths.match("/users/delta/messages")).toBe("/users/{user-id}/messages");
  });

  it("matches without caring about case, which Graph does not either", () => {
    expect(paths.match("/Users/abc/MemberOf")).toBe("/users/{user-id}/memberOf");
  });

  it("keeps an OData segment literal", () => {
    expect(paths.match("/groups/abc/members/$count")).toBe("/groups/{group-id}/members/$count");
  });

  it("returns nothing for a path the index does not hold", () => {
    expect(paths.match("/frobnicate")).toBeUndefined();
    // Every segment resolves, but nothing in the index ends here.
    expect(paths.match("/admin/edge")).toBeUndefined();
  });
});

describe("indexPaths.consistency", () => {
  it("is true only where the index carries Microsoft's marker", () => {
    expect(paths.consistency("/users")).toBe(true);
    expect(paths.consistency("/users/abc-123/memberOf")).toBe(true);
    expect(paths.consistency("/groups/abc-123/members")).toBe(true);
  });

  it("is undefined, never false, for a path the index does not mark", () => {
    // Absence of a marker is not a claim that the header is unneeded, so the caller has to be
    // able to tell "not marked" from "marked false". The index never writes false.
    expect(paths.consistency("/directoryRoles")).toBeUndefined();
    expect(paths.consistency("/users/abc-123/messages")).toBeUndefined();
  });

  it("is undefined for a path the index has no entry for at all", () => {
    expect(paths.consistency("/frobnicate")).toBeUndefined();
  });
});

describe("indexPaths.suggest", () => {
  it("finds the plural when the call used the singular name", () => {
    expect(paths.suggest("/user")).toContain("/users");
    expect(paths.suggest("/groups/abc-123/member")).toContain("/groups/{group-id}/members");
  });

  it("finds the right segment when one segment is misspelled", () => {
    expect(paths.suggest("/users/abc-123/membersOf")).toContain("/users/{user-id}/memberOf");
    expect(paths.suggest("/usres")).toContain("/users");
  });

  it("offers nothing when no segment is close, rather than something unrelated", () => {
    expect(paths.suggest("/frobnicate")).toEqual([]);
    expect(paths.suggest("/users/abc-123/frobnicate")).toEqual([]);
  });

  it("offers nothing for a path that already resolves", () => {
    expect(paths.suggest("/groups/abc-123/members")).toEqual([]);
  });

  it("offers the nearest real paths when every segment resolves but nothing ends there", () => {
    expect(paths.suggest("/admin/edge")).toEqual(["/admin/edge/internetExplorerMode/siteLists"]);
  });

  it("returns at most the limit it is given, closest first", () => {
    expect(paths.suggest("/user", 1)).toEqual(["/users"]);
  });
});

describe("against the packaged v1.0 index", () => {
  it("resolves paths a run would really call and reads their marker", async () => {
    const { index } = await loadGraphIndex();
    const real = indexPaths(index);

    expect(real.match("/users/admin@contoso.com")).toBe("/users/{user-id}");
    expect(real.match("/groups/00000000-0000-0000-0000-000000000001/members")).toBe("/groups/{group-id}/members");
    // The win this ticket is for: marked by Microsoft, missed by plan 1's hardcoded list.
    expect(real.consistency("/me/memberOf")).toBe(true);
    expect(real.consistency("/directoryRoles")).toBeUndefined();
    expect(real.suggest("/user")).toContain("/users");
  });
});

describe("createIndexPaths", () => {
  function loaded(index: GraphIndex): LoadedIndex {
    const text = JSON.stringify(index);
    return { index, text, loadMs: 0, bytes: Buffer.byteLength(text) };
  }

  it("builds the lookup once and reuses it", async () => {
    const load = vi.fn(async () => loaded(fixture));
    const get = createIndexPaths(load);

    const first = await get();
    const second = await get();

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers undefined when the index cannot be loaded, so a Graph call still goes out", async () => {
    // A missing or unreadable index must never fail a call that would have worked without it.
    const get = createIndexPaths(async () => {
      throw new Error("no index on disk");
    });

    await expect(get()).resolves.toBeUndefined();
  });
});
