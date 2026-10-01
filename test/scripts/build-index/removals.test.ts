import { describe, expect, it } from "vitest";

import { deriveGovRemovals } from "../../../scripts/build-index/removals.ts";
import type { GraphIndex } from "../../../src/core/index/graph-index.ts";

function csdl(body: string, roots: string): string {
  return `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
    <edmx:DataServices>
      <Schema Namespace="microsoft.graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
        ${body}
        <EntityContainer Name="GraphService">${roots}</EntityContainer>
      </Schema>
    </edmx:DataServices>
  </edmx:Edmx>`;
}

const commercialCsdl = csdl(
  `<EntityType Name="user"><NavigationProperty Name="profile" Type="microsoft.graph.profile" /></EntityType>
   <EntityType Name="profile" />
   <EntityType Name="device" />`,
  `<EntitySet Name="users" EntityType="microsoft.graph.user" />
   <EntitySet Name="devices" EntityType="microsoft.graph.device" />
   <Singleton Name="me" Type="microsoft.graph.user" />`,
);

const govCsdl = csdl(
  `<EntityType Name="user" />`,
  `<EntitySet Name="users" EntityType="microsoft.graph.user" />`,
);

const index: GraphIndex = {
  version: "v1.0",
  builtAt: "2026-09-16",
  types: {},
  enums: {},
  paths: {
    "/users": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/{user-id}": { methods: ["get"], entityType: "microsoft.graph.user" },
    "/users/{user-id}/profile": { methods: ["get"], entityType: "microsoft.graph.profile" },
    "/users/{user-id}/profile/check": { methods: ["post"] },
    "/devices": { methods: ["get"], entityType: "microsoft.graph.device" },
    "/me": { methods: ["get"], entityType: "microsoft.graph.user" },
  },
};

describe("deriveGovRemovals", () => {
  it("removes paths with an absent root or an absent entity type anywhere along the path", () => {
    expect(deriveGovRemovals(index, commercialCsdl, govCsdl)).toEqual([
      "/devices",
      "/me",
      "/users/{user-id}/profile",
      "/users/{user-id}/profile/check",
    ]);
  });

  it("removes bare actions and namespace-qualified function calls absent from Gov", () => {
    const commercial = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
      <edmx:DataServices>
        <Schema Namespace="microsoft.graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
          <EntityType Name="application" />
          <EntityType Name="communications" />
          <Action Name="setVerifiedPublisher" IsBound="true" />
          <EntityContainer Name="GraphService">
            <EntitySet Name="applications" EntityType="microsoft.graph.application" />
            <Singleton Name="communications" Type="microsoft.graph.communications" />
          </EntityContainer>
        </Schema>
        <Schema Namespace="microsoft.graph.callRecords" xmlns="http://docs.oasis-open.org/odata/ns/edm">
          <Function Name="getPstnCalls" IsBound="true" />
        </Schema>
      </edmx:DataServices>
    </edmx:Edmx>`;
    const gov = csdl(
      `<EntityType Name="application" /><EntityType Name="communications" />`,
      `<EntitySet Name="applications" EntityType="microsoft.graph.application" />
       <Singleton Name="communications" Type="microsoft.graph.communications" />`,
    );
    const operationIndex: GraphIndex = {
      version: "v1.0",
      builtAt: "2026-09-16",
      types: {},
      enums: {},
      paths: {
        "/applications/{application-id}/setVerifiedPublisher": { methods: ["post"] },
        "/communications/callRecords/microsoft.graph.callRecords.getPstnCalls(fromDateTime={fromDateTime},toDateTime={toDateTime})": {
          methods: ["get"],
        },
      },
    };

    expect(deriveGovRemovals(operationIndex, commercial, gov)).toEqual([
      "/applications/{application-id}/setVerifiedPublisher",
      "/communications/callRecords/microsoft.graph.callRecords.getPstnCalls(fromDateTime={fromDateTime},toDateTime={toDateTime})",
    ]);
  });
});
