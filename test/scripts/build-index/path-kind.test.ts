import { describe, expect, it } from "vitest";

import { untypedPathKind } from "../../../scripts/build-index/path-kind.ts";

const document = { components: { schemas: { ODataCountResponse: { type: "integer" } } } };

const jsonGet = { get: { responses: { "2XX": { content: { "application/json": { schema: { type: "object" } } } } } } };

describe("untypedPathKind", () => {
  it("calls a $count path a count", () => {
    const pathItem = { get: { responses: { "2XX": { content: { "text/plain": { schema: { type: "integer" } } } } } } };

    expect(untypedPathKind("/users/$count", pathItem, document)).toBe("count");
  });

  it("calls a $ref path a ref", () => {
    expect(untypedPathKind("/groups/{group-id}/members/$ref", { get: {}, post: {} }, document)).toBe("ref");
  });

  it("calls a path whose last segment is an OData call a function", () => {
    expect(untypedPathKind("/drives/{drive-id}/items/{driveItem-id}/delta()", jsonGet, document)).toBe("function");
  });

  it("calls a path with no GET an action", () => {
    expect(untypedPathKind("/users/{user-id}/restore", { post: {} }, document)).toBe("action");
  });

  it("calls a path whose GET returns bytes rather than JSON media", () => {
    const pathItem = { get: { responses: { "2XX": { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } }, put: {} };

    expect(untypedPathKind("/applications/{application-id}/logo", pathItem, document)).toBe("media");
  });

  it("calls a path whose GET returns JSON unclassified, because an untyped one of those is a build to look at", () => {
    expect(untypedPathKind("/somethingNew", jsonGet, document)).toBe("unclassified");
  });
});
