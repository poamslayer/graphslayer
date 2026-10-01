import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import type { GraphIndex } from "../../../src/core/index/graph-index.js";
import { loadGraphIndex } from "../../../src/core/index/loader.js";
import { searchIndex } from "../../../src/core/index/search.js";

const { index } = await loadGraphIndex();
const penaltyFixture: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: { "microsoft.graph.user": { properties: {} } },
  enums: {},
  paths: {
    "/users": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/{user-id}": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/graph.user": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/user()": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/user": { methods: ["post"], entityType: "microsoft.graph.user" },
  },
};

describe("searchIndex", () => {
  it("puts the users collection first for user", () => {
    const result = searchIndex(index, "user");

    expect(result.matches[0]?.path).toBe("/users");
    expect(result.matches.slice(0, 5).map((match) => match.path)).toContain("/users/{user-id}");
  });

  it("puts the groups collection first for groups", () => {
    expect(searchIndex(index, "groups").matches[0]?.path).toBe("/groups");
  });

  it("puts group members among the first results for members", () => {
    const paths = searchIndex(index, "members").matches.slice(0, 3).map((match) => match.path);

    expect(paths).toContain("/groups/{group-id}/members");
  });

  it("puts conditional access policies first for conditionalAccess", () => {
    expect(searchIndex(index, "conditionalAccess").matches[0]?.path).toBe("/identity/conditionalAccess/policies");
  });

  it("puts an exact path first", () => {
    const path = "/identity/conditionalAccess/policies";

    expect(searchIndex(index, path).matches[0]?.path).toBe(path);
  });

  it("finds user paths by the signInActivity property", () => {
    const first = searchIndex(index, "signInActivity").matches[0];

    expect(first?.path.startsWith("/users")).toBe(true);
    expect(first?.matchedOn).toBe("property signInActivity");
  });

  it("does not let an OData cast outrank the users collection", () => {
    const matches = searchIndex(index, "user", 1_000).matches;
    const users = matches.find((match) => match.path === "/users");
    const cast = matches.find((match) => match.path === "/applications/{application-id}/owners/graph.user");

    expect(cast).toBeDefined();
    expect(users?.score ?? 0).toBeGreaterThan(cast?.score ?? 0);
  });

  it("prefers a shallow GET path over placeholders, casts, functions, and write-only paths", () => {
    const matches = searchIndex(penaltyFixture, "user").matches;
    const collection = matches.find((match) => match.path === "/users");

    expect(collection).toBeDefined();
    expect(matches).toHaveLength(Object.keys(penaltyFixture.paths).length);
    for (const match of matches.filter((candidate) => candidate !== collection)) {
      expect(match.score).toBeLessThan(collection?.score ?? 0);
    }
  });

  it("answers a question asked in a sentence", () => {
    // The two questions the ticket is written around. An agent asks in prose as often as it
    // asks with a resource name, and nothing in the index is named "what properties does a
    // user have".
    expect(searchIndex(index, "what properties does a user have in tenant contoso").matches[0]?.path).toBe("/users");

    const members = searchIndex(index, "how do I list the members of a group").matches.slice(0, 3);

    expect(members.map((match) => match.path)).toContain("/groups/{group-id}/members");
  });

  it("prefers the path that answers more of the question", () => {
    // "members" alone scores lower than "group" alone, because it sits three segments deep.
    // Matching both words is what lifts it past the group collection's own sub-paths.
    const paths = searchIndex(index, "group members").matches.slice(0, 2).map((match) => match.path);

    expect(paths).toContain("/groups/{group-id}/members");
  });

  it("offers closest paths when nothing matches", () => {
    const result = searchIndex(index, "zzzznotathing");

    expect(result.matches).toEqual([]);
    expect(result.closest.length).toBeGreaterThan(0);
  });

  it("treats /user as a near miss for /users", () => {
    const result = searchIndex(index, "/user");

    expect(result.matches[0]?.path).toBe("/users");
    expect(result.closest).toEqual([]);
  });

  it("measures a user search over the packaged index", () => {
    const started = performance.now();
    const result = searchIndex(index, "user");
    const searchMs = performance.now() - started;

    console.log(`graph index search: ${searchMs.toFixed(2)} ms`);
    expect(result.matches[0]?.path).toBe("/users");
  });
});
