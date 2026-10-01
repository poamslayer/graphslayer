import { describe, expect, it } from "vitest";

import { assembleIndex } from "../../../scripts/build-index/assemble.ts";
import { readScopes } from "../../../scripts/build-index/scopes.ts";

const csdl = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="microsoft.graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="entity" Abstract="true"><Property Name="id" Type="Edm.String" /></EntityType>
      <EntityType Name="user" BaseType="microsoft.graph.entity"><Property Name="displayName" Type="Edm.String" /></EntityType>
      <EnumType Name="calendarRoleType"><Member Name="none" Value="0" /></EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const schemas = {
  "microsoft.graph.user": { type: "object" },
  "microsoft.graph.calendarRoleType": { title: "calendarRoleType", enum: ["none", "freeBusyRead"], type: "string" },
  BaseCollectionPaginationCountResponse: { type: "object", properties: { "@odata.count": { type: "integer" } } },
  "microsoft.graph.userCollectionResponse": {
    type: "object",
    allOf: [
      { $ref: "#/components/schemas/BaseCollectionPaginationCountResponse" },
      { type: "object", properties: { value: { type: "array", items: { $ref: "#/components/schemas/microsoft.graph.user" } } } },
    ],
  },
};

function json(schema: unknown) {
  return { "2XX": { description: "Retrieved", content: { "application/json": { schema } } } };
}

const openapi = {
  paths: {
    "/users": {
      get: {
        parameters: [{ name: "ConsistencyLevel", in: "header" }, { name: "$filter", in: "query" }],
        responses: json({ $ref: "#/components/schemas/microsoft.graph.userCollectionResponse" }),
      },
      post: { responses: json({ $ref: "#/components/schemas/microsoft.graph.user" }) },
    },
    "/users/{user-id}": {
      get: { responses: json({ $ref: "#/components/schemas/microsoft.graph.user" }) },
    },
    "/users/$count": {
      get: { responses: { "2XX": { content: { "text/plain": { schema: { type: "integer" } } } } } },
    },
    "/users/{user-id}/restore": { post: { responses: { "204": { description: "Success" } } } },
    "/somethingNew": { get: { responses: json({ type: "object" }) } },
    "/calendar/role": { get: { responses: json({ $ref: "#/components/schemas/microsoft.graph.calendarRoleType" }) } },
    "/documented": { description: "a path with no operations at all" },
  },
  components: { schemas },
};

const scopes = readScopes({
  permissions: {
    "User.Read.All": {
      schemes: { DelegatedWork: {}, Application: {} },
      pathSets: [{ schemeKeys: ["DelegatedWork", "Application"], methods: ["GET"], paths: { "/users": "least=DelegatedWork,Application" } }],
    },
  },
});

// The fixture CSDL declares a two-property user, so the curated table is scoped to match it.
// A real build takes the shipped table, and every name in it has to resolve or the build fails.
const built = assembleIndex({
  version: "v1.0",
  builtAt: "2026-09-16",
  openapi,
  csdl,
  scopes,
  curatedDefaultSelect: { "microsoft.graph.user": ["id", "displayName"] },
});

describe("assembleIndex", () => {
  it("puts the curated default on the type, where a path reaches it through entityType", () => {
    expect(built.index.types["microsoft.graph.user"].defaultSelect).toEqual(["id", "displayName"]);
    // Both /users and /users/{user-id} in the fixture return a user, so one curated type
    // reaches two paths. That is the point of keying by type rather than by path.
    expect(built.report.defaultSelect).toEqual({ types: 1, paths: 2 });
  });

  it("fails the build when a curated name is not a real property, rather than shipping it", () => {
    expect(() => assembleIndex({
      version: "v1.0",
      builtAt: "2026-09-16",
      openapi,
      csdl,
      scopes,
      curatedDefaultSelect: { "microsoft.graph.user": ["id", "notAProperty"] },
    })).toThrow(/notAProperty/);
  });

  it("records the methods a path answers", () => {
    expect(built.index.paths["/users"].methods).toEqual(["get", "post"]);
  });

  it("names the entity type rather than inlining it, so the type is stored once", () => {
    expect(built.index.paths["/users"].entityType).toBe("microsoft.graph.user");
    expect(built.index.types["microsoft.graph.user"].properties).toEqual({ id: "Edm.String", displayName: "Edm.String" });
  });

  it("carries enum members beside the property-bearing types", () => {
    expect(built.index.enums["microsoft.graph.calendarRoleType"]).toEqual({ members: ["none"] });
  });

  it("carries the consistency flag from the description's own header parameter", () => {
    expect(built.index.paths["/users"].consistency).toBe(true);
  });

  it("omits the flag where the description carries no marker, because absence is not proof it is unneeded", () => {
    expect(built.index.paths["/users/{user-id}"]).not.toHaveProperty("consistency");
  });

  it("records scopes for the method the permissions reference covers", () => {
    expect(built.index.paths["/users"].scopes?.get).toEqual({
      delegated: { least: ["User.Read.All"], all: ["User.Read.All"] },
      application: { least: ["User.Read.All"], all: ["User.Read.All"] },
    });
  });

  it("leaves scopes absent for a method the reference says nothing about, rather than recording an empty set", () => {
    expect(built.index.paths["/users"].scopes).not.toHaveProperty("post");
    expect(built.index.paths["/users/{user-id}"].scopes).toBeUndefined();
  });

  it("skips a path item that declares no operations", () => {
    expect(built.index.paths["/documented"]).toBeUndefined();
  });

  it("counts the paths that resolved an entity type", () => {
    expect(built.report.typedPaths).toBe(2);
  });

  it("gives no entityType to a path that returns a bare enum, because the types table cannot hold one", () => {
    expect(built.index.paths["/calendar/role"].entityType).toBeUndefined();
  });

  it("accounts for every untyped path by kind, enums included", () => {
    expect(built.report.untypedByKind).toEqual({ count: 1, action: 1, enum: 1, unclassified: 1 });
  });

  it("names the untyped paths that fit no kind, so a new shape is not silently dropped", () => {
    expect(built.report.unclassifiedPaths).toEqual(["/somethingNew"]);
  });

  it("reports how much of the index the permissions join reached", () => {
    expect(built.report.scopeCoverage).toEqual({ paths: 6, matched: 2 });
  });

  it("gives a $count the scope of the collection it counts, which is the same read", () => {
    // The reference grants User.Read.All on /users and says nothing about /users/$count.
    // Counting a collection needs what reading it needs, so #25's normalization folds the
    // OData segment onto the collection rather than leaving the count uncovered.
    expect(built.index.paths["/users/$count"].scopes?.get?.delegated?.least).toEqual(["User.Read.All"]);
    expect(built.index.paths["/users"].scopes?.get?.delegated?.least).toEqual(["User.Read.All"]);
  });
});

describe("assembleIndex when an entity type is missing from the CSDL", () => {
  it("drops the name and raises it in the report, so every entityType keys into types", () => {
    const orphan = {
      paths: { "/orphans": { get: { responses: json({ $ref: "#/components/schemas/microsoft.graph.orphan" }) } } },
      components: { schemas: { "microsoft.graph.orphan": { type: "object" } } },
    };

    const result = assembleIndex({
      version: "v1.0",
      builtAt: "2026-09-16",
      openapi: orphan,
      csdl,
      scopes,
      curatedDefaultSelect: { "microsoft.graph.user": ["id", "displayName"] },
    });

    expect(result.index.paths["/orphans"].entityType).toBeUndefined();
    expect(result.report.unresolvedEntityTypes).toEqual(["microsoft.graph.orphan"]);
  });
});
