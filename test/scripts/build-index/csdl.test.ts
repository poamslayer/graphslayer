import { describe, expect, it } from "vitest";

import { readTypes, typesDerivedFrom } from "../../../scripts/build-index/csdl.ts";

const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="microsoft.graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="bodyType" IsFlags="true">
        <Member Name="text" Value="0" />
        <Member Name="html" Value="1" />
      </EnumType>
      <EntityType Name="entity" Abstract="true">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.String" />
      </EntityType>
      <EntityType Name="directoryObject" BaseType="microsoft.graph.entity" OpenType="true">
        <Property Name="deletedDateTime" Type="Edm.DateTimeOffset" />
      </EntityType>
      <EntityType Name="user" BaseType="microsoft.graph.directoryObject" OpenType="true">
        <Property Name="displayName" Type="Edm.String" />
        <Property Name="assignedLicenses" Type="Collection(microsoft.graph.assignedLicense)" Nullable="false" />
        <NavigationProperty Name="manager" Type="microsoft.graph.directoryObject" />
      </EntityType>
      <EntityType Name="message" BaseType="microsoft.graph.entity">
        <Property Name="subject" Type="Edm.String" />
      </EntityType>
      <ComplexType Name="assignedLicense">
        <Property Name="skuId" Type="Edm.Guid" />
      </ComplexType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("readTypes", () => {
  it("carries a type's own properties and the ones it inherits through BaseType", () => {
    const { types } = readTypes(csdl);

    expect(types["microsoft.graph.user"].properties).toMatchObject({
      id: "Edm.String",
      deletedDateTime: "Edm.DateTimeOffset",
      displayName: "Edm.String",
    });
  });

  it("records a navigation property alongside the structural ones", () => {
    const { types } = readTypes(csdl);

    expect(types["microsoft.graph.user"].properties.manager).toBe("microsoft.graph.directoryObject");
  });

  it("keeps a collection property's element type visible", () => {
    const { types } = readTypes(csdl);

    expect(types["microsoft.graph.user"].properties.assignedLicenses).toBe("Collection(microsoft.graph.assignedLicense)");
  });

  it("includes complex types, which a property can reference by name", () => {
    const { types } = readTypes(csdl);

    expect(types["microsoft.graph.assignedLicense"].properties).toEqual({ skuId: "Edm.Guid" });
  });

  it("leaves enum types out of the table, because they have no properties", () => {
    const { types } = readTypes(csdl);

    expect(types["microsoft.graph.bodyType"]).toBeUndefined();
  });

  it("carries enum members in declaration order and marks a flags enum", () => {
    const { enums } = readTypes(csdl);

    expect(enums.get("microsoft.graph.bodyType")).toEqual({ members: ["text", "html"], isFlags: true });
    expect(enums.has("microsoft.graph.user")).toBe(false);
  });
});

describe("typesDerivedFrom", () => {
  it("finds the types that reach a base transitively, and the base itself", () => {
    const csdlTypes = readTypes(csdl);

    expect(typesDerivedFrom(csdlTypes, "microsoft.graph.directoryObject")).toEqual(
      new Set(["microsoft.graph.directoryObject", "microsoft.graph.user"]),
    );
  });

  it("leaves out a type that shares only a more distant ancestor", () => {
    const csdlTypes = readTypes(csdl);

    expect(typesDerivedFrom(csdlTypes, "microsoft.graph.directoryObject").has("microsoft.graph.message")).toBe(false);
  });
});

const aliased = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="microsoft.graph" Alias="graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="entity" Abstract="true"><Property Name="id" Type="Edm.String" /></EntityType>
      <EntityType Name="directoryObject" BaseType="graph.entity"><Property Name="deletedDateTime" Type="Edm.DateTimeOffset" /></EntityType>
      <EntityType Name="user" BaseType="graph.directoryObject">
        <Property Name="signInActivity" Type="graph.signInActivity" />
        <Property Name="assignedLicenses" Type="Collection(graph.assignedLicense)" />
      </EntityType>
      <ComplexType Name="signInActivity"><Property Name="lastSignInDateTime" Type="Edm.DateTimeOffset" /></ComplexType>
      <ComplexType Name="assignedLicense"><Property Name="skuId" Type="Edm.Guid" /></ComplexType>
    </Schema>
    <Schema Namespace="microsoft.graph.security" Alias="self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="alert" BaseType="graph.entity"><Property Name="evidence" Type="Collection(self.alertEvidence)" /></EntityType>
      <ComplexType Name="alertEvidence"><Property Name="createdDateTime" Type="Edm.DateTimeOffset" /></ComplexType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("readTypes when the CSDL writes types through a schema alias", () => {
  it("inherits through a BaseType written as an alias, so a user still has an id", () => {
    const { types } = readTypes(aliased);

    expect(types["microsoft.graph.user"].properties.id).toBe("Edm.String");
    expect(types["microsoft.graph.user"].properties.deletedDateTime).toBe("Edm.DateTimeOffset");
  });

  it("writes a property's type as the name the types table is keyed by", () => {
    const { types } = readTypes(aliased);

    expect(types["microsoft.graph.user"].properties.signInActivity).toBe("microsoft.graph.signInActivity");
    expect(types["microsoft.graph.signInActivity"]).toBeDefined();
  });

  it("resolves the alias inside a collection's element type", () => {
    const { types } = readTypes(aliased);

    expect(types["microsoft.graph.user"].properties.assignedLicenses).toBe("Collection(microsoft.graph.assignedLicense)");
  });

  it("resolves an alias that does not look like its namespace at all", () => {
    const { types } = readTypes(aliased);

    expect(types["microsoft.graph.security.alert"].properties.evidence).toBe("Collection(microsoft.graph.security.alertEvidence)");
    expect(types["microsoft.graph.security.alert"].properties.id).toBe("Edm.String");
  });

  it("leaves a primitive type alone", () => {
    const { types } = readTypes(aliased);

    expect(types["microsoft.graph.signInActivity"].properties.lastSignInDateTime).toBe("Edm.DateTimeOffset");
  });
});

describe("typesDerivedFrom when the CSDL writes base types through an alias", () => {
  it("still walks the chain", () => {
    expect(typesDerivedFrom(readTypes(aliased), "microsoft.graph.entity")).toContain("microsoft.graph.user");
  });
});
