import { describe, it, expect } from "vitest";
import { CURATED_DEFAULT_SELECT, curatedProblems } from "../../../scripts/build-index/default-select.ts";

const types = {
  "microsoft.graph.user": { properties: { id: "Edm.String", displayName: "Edm.String" } },
};

describe("curatedProblems", () => {
  it("is silent when every curated name is a real property", () => {
    expect(curatedProblems(types, { "microsoft.graph.user": ["id", "displayName"] })).toEqual([]);
  });

  it("names a curated property the type does not have", () => {
    expect(curatedProblems(types, { "microsoft.graph.user": ["id", "surname"] })).toEqual([
      { type: "microsoft.graph.user", missing: ["surname"] },
    ]);
  });

  it("reports a whole entry when the type itself is gone, rather than skipping it", () => {
    expect(curatedProblems(types, { "microsoft.graph.ghost": ["id"] })).toEqual([
      { type: "microsoft.graph.ghost", missing: ["id"] },
    ]);
  });

  it("every curated name is unique and non-empty, so the table cannot carry a typo twice", () => {
    for (const [type, properties] of Object.entries(CURATED_DEFAULT_SELECT)) {
      expect(properties.length, type).toBeGreaterThan(0);
      expect(new Set(properties).size, type).toBe(properties.length);
      expect(properties, type).toContain("id");
    }
  });
});
