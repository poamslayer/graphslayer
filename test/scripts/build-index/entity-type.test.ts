import { describe, expect, it } from "vitest";

import { entityTypeForOperation } from "../../../scripts/build-index/entity-type.ts";

const schemas = {
  "microsoft.graph.user": { title: "user", type: "object" },
  BaseCollectionPaginationCountResponse: {
    title: "Base collection pagination count response",
    type: "object",
    properties: { "@odata.count": { type: "integer" }, "@odata.nextLink": { type: "string" } },
  },
  "microsoft.graph.userCollectionResponse": {
    title: "Collection of user",
    type: "object",
    allOf: [
      { $ref: "#/components/schemas/BaseCollectionPaginationCountResponse" },
      { type: "object", properties: { value: { type: "array", items: { $ref: "#/components/schemas/microsoft.graph.user" } } } },
    ],
  },
  ODataCountResponse: { type: "integer", format: "int32" },
  // A real Graph entity whose name ends the way a collection envelope's does.
  "microsoft.graph.deviceLogCollectionResponse": {
    allOf: [
      { $ref: "#/components/schemas/microsoft.graph.entity" },
      { title: "deviceLogCollectionResponse", type: "object", properties: { enrolledByUser: { type: "string" } } },
    ],
  },
  "microsoft.graph.entity": { title: "entity", type: "object", properties: { id: { type: "string" } } },
  // A collection of primitives. It is an envelope, but its items carry no name to reach.
  StringCollectionResponse: {
    allOf: [
      { $ref: "#/components/schemas/BaseCollectionPaginationCountResponse" },
      { type: "object", properties: { value: { type: "array", items: { type: "string" } } } },
    ],
  },
};

const spec = { components: { schemas } };

function jsonResponse(schema: unknown) {
  return { description: "Retrieved entity", content: { "application/json": { schema } } };
}

describe("entityTypeForOperation", () => {
  it("reads the success response Graph actually keys, which is 2XX and not 200", () => {
    const operation = {
      responses: { "2XX": jsonResponse({ $ref: "#/components/schemas/microsoft.graph.user" }), "4XX": { description: "error" } },
    };

    expect(entityTypeForOperation(operation, spec)).toBe("microsoft.graph.user");
  });

  it("reaches the item type of a collection whose allOf puts the pagination envelope first", () => {
    const operation = {
      responses: { "2XX": jsonResponse({ $ref: "#/components/schemas/microsoft.graph.userCollectionResponse" }) },
    };

    expect(entityTypeForOperation(operation, spec)).toBe("microsoft.graph.user");
  });

  it("reads a plain 200 response when a path has one", () => {
    const operation = { responses: { "200": jsonResponse({ $ref: "#/components/schemas/microsoft.graph.user" }) } };

    expect(entityTypeForOperation(operation, spec)).toBe("microsoft.graph.user");
  });

  it("has no entity type for a $count response, which is a bare integer", () => {
    const operation = {
      responses: { "2XX": { description: "The count", content: { "text/plain": { schema: { $ref: "#/components/schemas/ODataCountResponse" } } } } },
    };

    expect(entityTypeForOperation(operation, spec)).toBeNull();
  });

  it("reads through the anyOf Graph wraps a nullable single entity in", () => {
    const operation = {
      responses: {
        "2XX": jsonResponse({
          anyOf: [{ $ref: "#/components/schemas/microsoft.graph.user" }, { type: "object", nullable: true }],
        }),
      },
    };

    expect(entityTypeForOperation(operation, spec)).toBe("microsoft.graph.user");
  });

  it("keeps a real entity whose name happens to end the way an envelope's does", () => {
    const operation = {
      responses: { "2XX": jsonResponse({ $ref: "#/components/schemas/microsoft.graph.deviceLogCollectionResponse" }) },
    };

    expect(entityTypeForOperation(operation, spec)).toBe("microsoft.graph.deviceLogCollectionResponse");
  });

  it("has no entity type for a collection of primitives, rather than naming the wrapper", () => {
    const operation = {
      responses: { "2XX": jsonResponse({ $ref: "#/components/schemas/StringCollectionResponse" }) },
    };

    expect(entityTypeForOperation(operation, spec)).toBeNull();
  });

  it("has no entity type when the success response carries no content", () => {
    const operation = { responses: { "204": { description: "Success" } } };

    expect(entityTypeForOperation(operation, spec)).toBeNull();
  });
});
