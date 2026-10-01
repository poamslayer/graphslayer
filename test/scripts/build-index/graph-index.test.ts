/** What the shipped index has to be true of. These read data/graph-index.json, not a fixture. */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { INDEX_SIZE_LIMIT_BYTES } from "../../../scripts/build-index/assemble.ts";
import type { GraphIndex } from "../../../scripts/build-index/assemble.ts";

const indexPath = resolve(process.cwd(), "data/graph-index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8")) as GraphIndex;

/**
 * What this build measures, not what the prototype measured. The prototype's 6,168 is a floor
 * rather than a target: it missed the 697 paths whose response is a nullable `anyOf`, so
 * pinning to it would reject the fix for them.
 *
 * The band exists to catch the resolver defects, which are catastrophic rather than marginal.
 * Reading `200` instead of `2XX` takes the count to 0. Walking `allOf` in order sends
 * thousands of paths to the pagination envelope instead of the entity and pushes it past
 * 8,000. Either lands well outside.
 */
const MEASURED_TYPED_PATHS = 6858;

describe("the shipped Graph index", () => {
  it("is under the 32 MB half of the measured 63 MB isolate budget", () => {
    expect(statSync(indexPath).size).toBeLessThan(INDEX_SIZE_LIMIT_BYTES);
  });

  it("is the v1.0 index, and says when it was built", () => {
    expect(index.version).toBe("v1.0");
    expect(index.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves an entity type for about as many paths as this build measured", () => {
    const typed = Object.values(index.paths).filter((entry) => entry.entityType).length;

    expect(typed).toBeGreaterThan(MEASURED_TYPED_PATHS * 0.95);
    expect(typed).toBeLessThan(MEASURED_TYPED_PATHS * 1.05);
  });

  it("reads through the anyOf that wraps a nullable single entity", () => {
    expect(index.paths["/drives/{drive-id}/items/{driveItem-id}/workbook/names/{workbookNamedItem-id}/range()"].entityType)
      .toBe("microsoft.graph.workbookRange");
  });

  it("keeps a real entity whose name ends the way a collection envelope's does", () => {
    const path = "/deviceManagement/managedDevices/{managedDevice-id}/logCollectionRequests/{deviceLogCollectionResponse-id}";

    expect(index.paths[path].entityType).toBe("microsoft.graph.deviceLogCollectionResponse");
  });

  it("resolves a collection to its item type rather than to the pagination envelope", () => {
    expect(index.paths["/users"].entityType).toBe("microsoft.graph.user");
    expect(index.paths["/groups"].entityType).toBe("microsoft.graph.group");
  });

  it("keeps types in one shared table that paths reach by name", () => {
    const user = index.types[index.paths["/users"].entityType ?? ""];

    expect(user.properties.displayName).toBe("Edm.String");
    expect(user.properties.signInActivity).toBe("microsoft.graph.signInActivity");
  });

  it("writes a property's type as a key of the types table, not as the CSDL's schema alias", () => {
    const signInActivity = index.types["microsoft.graph.user"].properties.signInActivity;

    expect(index.types[signInActivity]).toBeDefined();
    expect(index.types["microsoft.graph.user"].properties.assignedLicenses).toBe("Collection(microsoft.graph.assignedLicense)");
  });

  it("carries the permitted values of an enum a property names", () => {
    const riskLevel = index.types["microsoft.graph.riskyUser"].properties.riskLevel;

    expect(riskLevel).toBe("microsoft.graph.riskLevel");
    expect(index.enums?.[riskLevel]?.members).toEqual([
      "low",
      "medium",
      "high",
      "hidden",
      "none",
      "unknownFutureValue",
    ]);
  });

  /**
   * The paths an assessment actually reads, written from what plan 1's task tools reach for
   * rather than from what happened to pass. #25 measured the permissions join at 31% over all
   * 11,546 paths and 100% over these, which is why the bar for that join is this list rather
   * than a percentage: a rebuild that quietly lost one of these would not move the percentage
   * enough to notice.
   */
  const ENTRY_POINTS = [
    "/users", "/users/{user-id}", "/users/{user-id}/memberOf", "/users/{user-id}/licenseDetails",
    "/groups", "/groups/{group-id}", "/groups/{group-id}/members", "/groups/{group-id}/owners",
    "/devices", "/devices/{device-id}",
    "/applications", "/applications/{application-id}",
    "/servicePrincipals", "/servicePrincipals/{servicePrincipal-id}",
    "/directoryRoles", "/directoryRoles/{directoryRole-id}/members",
    "/identity/conditionalAccess/policies", "/identity/conditionalAccess/namedLocations",
    "/subscribedSkus", "/organization", "/domains",
    "/auditLogs/signIns", "/auditLogs/directoryAudits",
    "/policies/authorizationPolicy", "/roleManagement/directory/roleAssignments",
    "/reports/authenticationMethods/userRegistrationDetails",
  ];

  it("knows the delegated GET scopes for every path an assessment actually reads", () => {
    const withoutScopes = ENTRY_POINTS.filter((path) => {
      const entry = index.paths[path];
      const delegated = entry?.scopes?.get?.delegated;
      return !delegated || (delegated.least ?? delegated.all).length === 0;
    });

    expect(withoutScopes).toEqual([]);
  });

  it("gives every curated default select only real properties of its own type", () => {
    const withDefault = Object.entries(index.types).filter(([, entry]) => entry.defaultSelect);

    expect(withDefault.length).toBe(9);
    for (const [type, entry] of withDefault) {
      for (const property of entry.defaultSelect ?? []) {
        expect(entry.properties[property], `${type}.${property}`).toBeDefined();
      }
    }
  });

  it("reaches the directory collections a default is for, through entityType", () => {
    const selectFor = (path: string) => {
      const entityType = index.paths[path]?.entityType;
      return entityType === undefined ? undefined : index.types[entityType]?.defaultSelect;
    };

    expect(selectFor("/users")).toContain("userPrincipalName");
    expect(selectFor("/groups")).toContain("securityEnabled");
    expect(selectFor("/subscribedSkus")).toContain("skuPartNumber");
    // A collection of directory objects is not a collection of users, so it gets no user fields.
    expect(selectFor("/groups/{group-id}/members")).toBeUndefined();
  });

  it("resolves every non-primitive property type to a type or enum, with no exceptions", () => {
    const unresolved = Object.entries(index.types).flatMap(([owner, entry]) =>
      Object.entries(entry.properties).flatMap(([property, writtenType]) => {
        const collection = writtenType.match(/^Collection\((.*)\)$/);
        const type = collection?.[1] ?? writtenType;
        if (type.startsWith("Edm.") || index.types[type] || index.enums?.[type]) return [];
        return [`${owner}.${property}: ${writtenType}`];
      }));

    expect(unresolved).toEqual([]);
  });

  it("gives a user the properties it inherits, which an unresolved alias would silently drop", () => {
    expect(index.types["microsoft.graph.user"].properties.id).toBe("Edm.String");
    expect(index.types["microsoft.graph.user"].properties.deletedDateTime).toBe("Edm.DateTimeOffset");
  });

  it("inlines no type into a path, because inlining Graph's types projects to about 16 GB", () => {
    const inlined = Object.entries(index.paths).filter(([, entry]) => "properties" in entry || typeof entry.entityType === "object");

    expect(inlined).toEqual([]);
  });

  it("names every entity type a path points at in the types table, with no exceptions", () => {
    const named = new Set(Object.values(index.paths).flatMap((entry) => (entry.entityType ? [entry.entityType] : [])));

    expect([...named].filter((name) => !index.types[name])).toEqual([]);
  });

  it("flags the paths Microsoft marks as needing the consistency header", () => {
    expect(index.paths["/users"].consistency).toBe(true);
    // The hardcoded directory-prefix list in plan 1 never reached this one.
    expect(index.paths["/me/memberOf"].consistency).toBe(true);
  });

  it("leaves the flag off an unmarked path rather than asserting the header is unneeded", () => {
    // Microsoft documents advanced-query cases for administrative units, yet publishes no
    // marker here. A hard false would tell the client to drop a header the call needs, so an
    // unmarked path carries no key and the client falls back to what it did before.
    expect(index.paths["/directory/administrativeUnits"]).not.toHaveProperty("consistency");
    expect(index.paths["/me/messages"]).not.toHaveProperty("consistency");
  });

  it("records scopes where the permissions reference joined and says nothing where it did not", () => {
    expect(index.paths["/users"].scopes?.get?.delegated?.least).toContain("User.ReadBasic.All");
    // The permissions join reaches about a fifth of Graph, and an absent entry has to stay
    // absent so nothing downstream reads "the index does not know" as "no scope is needed".
    expect(index.paths["/users/{user-id}/activities/{userActivity-id}/historyItems"].scopes).toBeUndefined();
  });

  it("never writes an empty scope shape, which a consumer would read as needing no consent", () => {
    const families = Object.values(index.paths)
      .flatMap((entry) => Object.values(entry.scopes ?? {}))
      .flatMap((set) => [set.delegated, set.application]);

    expect(families.filter((family) => family && (family.all.length === 0 || family.least?.length === 0))).toEqual([]);
  });

  it("says what a least privileged scope additionally requires, so one consent is not mistaken for enough", () => {
    const delegated = index.paths["/applications/{application-id}/tokenIssuancePolicies"].scopes?.get?.delegated;

    // Consenting to the least privileged scope alone still leaves this call failing.
    expect(delegated?.least).toEqual(["Application.ReadWrite.All"]);
    expect(delegated?.alsoRequires?.["Application.ReadWrite.All"]).toEqual(["Policy.Read.All"]);
  });

  it("carries every method a path answers", () => {
    expect(index.paths["/users"].methods).toEqual(["get", "post"]);
    expect(index.paths["/users/{user-id}"].methods).toEqual(["get", "patch", "delete"]);
  });
});
