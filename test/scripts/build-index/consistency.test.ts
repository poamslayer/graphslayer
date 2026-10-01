import { describe, expect, it } from "vitest";

import { needsConsistencyHeader } from "../../../scripts/build-index/consistency.ts";

const document = {
  components: {
    parameters: {
      consistencyLevel: { name: "ConsistencyLevel", in: "header", description: "Indicates the requested consistency level." },
      filter: { name: "$filter", in: "query", description: "Filter items by property values" },
    },
  },
};

describe("needsConsistencyHeader", () => {
  it("reads the ConsistencyLevel header parameter Microsoft declares on the operation", () => {
    const pathItem = { get: { parameters: [{ name: "ConsistencyLevel", in: "header" }, { name: "$filter", in: "query" }] } };

    expect(needsConsistencyHeader(pathItem, document)).toBe(true);
  });

  it("resolves a parameter the operation reaches by reference", () => {
    const pathItem = { get: { parameters: [{ $ref: "#/components/parameters/consistencyLevel" }] } };

    expect(needsConsistencyHeader(pathItem, document)).toBe(true);
  });

  it("counts a parameter declared on the path rather than on the operation", () => {
    const pathItem = { parameters: [{ name: "ConsistencyLevel", in: "header" }], get: {} };

    expect(needsConsistencyHeader(pathItem, document)).toBe(true);
  });

  it("is false for a collection that takes the query options but is not a directory object", () => {
    const pathItem = { get: { parameters: [{ $ref: "#/components/parameters/filter" }, { name: "$orderby", in: "query" }] } };

    expect(needsConsistencyHeader(pathItem, document)).toBe(false);
  });

  it("is false when a header of that name is a query option rather than a header", () => {
    const pathItem = { get: { parameters: [{ name: "ConsistencyLevel", in: "query" }] } };

    expect(needsConsistencyHeader(pathItem, document)).toBe(false);
  });

  it("is false for a path with no GET, because advanced queries are reads", () => {
    const pathItem = { post: { parameters: [{ name: "ConsistencyLevel", in: "header" }] } };

    expect(needsConsistencyHeader(pathItem, document)).toBe(false);
  });
});
