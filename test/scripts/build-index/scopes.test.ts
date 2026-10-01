import { describe, expect, it } from "vitest";

import { normalizeScopePath, readScopes, scopesFor } from "../../../scripts/build-index/scopes.ts";

const reference = {
  permissions: {
    "User.Read.All": {
      schemes: { DelegatedWork: {}, Application: {} },
      pathSets: [
        { schemeKeys: ["DelegatedWork", "Application"], methods: ["GET"], paths: { "/users/{id}": "least=DelegatedWork,Application" } },
      ],
    },
    "User.ReadWrite.All": {
      schemes: { DelegatedWork: {}, Application: {} },
      pathSets: [
        { schemeKeys: ["DelegatedWork", "Application"], methods: ["GET", "PATCH"], paths: { "/users/{id}": "" } },
      ],
    },
    "User.ReadBasic.All": {
      schemes: { DelegatedPersonal: {} },
      pathSets: [{ schemeKeys: ["DelegatedPersonal"], methods: ["GET"], paths: { "/users/{id}": "least=DelegatedPersonal" } }],
    },
    "Application.ReadWrite.All": {
      schemes: { DelegatedWork: {}, Application: {} },
      pathSets: [
        {
          schemeKeys: ["DelegatedWork", "Application"],
          methods: ["GET"],
          paths: { "/applications/{id}/tokenissuancepolicies": "least=DelegatedWork;AlsoRequires=Policy.Read.All" },
        },
      ],
    },
    "Directory.Read.All": {
      schemes: { DelegatedWork: {} },
      pathSets: [{ schemeKeys: ["DelegatedWork"], methods: ["GET"], paths: { "/contracts": "" } }],
    },
  },
};

const index = readScopes(reference);

describe("scopesFor", () => {
  it("matches a Graph path whatever the parameter is named and whatever the case", () => {
    expect(scopesFor(index, "/users/{user-id}", "get")).toBeDefined();
  });

  it("separates the least privileged scopes from every scope that grants the call", () => {
    expect(scopesFor(index, "/users/{user-id}", "get")?.delegated).toEqual({
      least: ["User.Read.All", "User.ReadBasic.All"],
      all: ["User.Read.All", "User.ReadBasic.All", "User.ReadWrite.All"],
    });
  });

  it("files a scope under application or delegated by the scheme it is granted under", () => {
    expect(scopesFor(index, "/users/{user-id}", "get")?.application).toEqual({
      least: ["User.Read.All"],
      all: ["User.Read.All", "User.ReadWrite.All"],
    });
  });

  it("says nothing at all about a path the reference does not list, rather than saying no scope is needed", () => {
    expect(scopesFor(index, "/admin/serviceAnnouncement/messages", "get")).toBeUndefined();
  });

  it("says nothing about a method the reference does not list on a path it does list", () => {
    expect(scopesFor(index, "/users/{user-id}", "delete")).toBeUndefined();
  });

  it("carries the scope a least privileged scope additionally requires, because one consent is not enough", () => {
    expect(scopesFor(index, "/applications/{application-id}/tokenIssuancePolicies", "get")?.delegated).toEqual({
      least: ["Application.ReadWrite.All"],
      all: ["Application.ReadWrite.All"],
      alsoRequires: { "Application.ReadWrite.All": ["Policy.Read.All"] },
    });
  });

  it("omits least rather than recording an empty one, so an unmarked scope set is never read as needing nothing", () => {
    const contracts = scopesFor(index, "/contracts", "get");

    expect(contracts?.delegated).toEqual({ all: ["Directory.Read.All"] });
    expect(contracts?.delegated).not.toHaveProperty("least");
  });

  it("omits a family the reference grants nothing under, rather than recording it empty", () => {
    expect(scopesFor(index, "/contracts", "get")).not.toHaveProperty("application");
  });

  it("counts a scope with no least marker among the scopes that grant the call", () => {
    expect(scopesFor(index, "/users/{user-id}", "patch")).toEqual({
      delegated: { all: ["User.ReadWrite.All"] },
      application: { all: ["User.ReadWrite.All"] },
    });
  });
});

describe("normalizeScopePath only strips what is actually a type cast", () => {
  it("folds the alias cast onto the resource, which is the same read", () => {
    expect(normalizeScopePath("/directoryRoles/{id}/members/{id}/graph.application"))
      .toBe(normalizeScopePath("/directoryRoles/{id}/members/{id}"));
  });

  /**
   * `microsoft.graph.security.moveAlerts` is an action, not a cast. Stripping it handed the
   * action whatever `/security/alerts_v2` is granted: measured before this was anchored, it
   * inherited `SecurityAlert.Create.All`, which the reference says nothing about moving an
   * alert. A scope the reference never stated is worse than no scope at all.
   */
  it("leaves a namespaced action alone, so it cannot inherit its collection's scopes", () => {
    const action = "/security/alerts_v2/microsoft.graph.security.moveAlerts";

    expect(normalizeScopePath(action)).not.toBe(normalizeScopePath("/security/alerts_v2"));
    expect(normalizeScopePath(action)).toBe("/security/alerts_v2/microsoft.graph.security.movealerts");
  });

  it("folds a $count onto the collection it counts, which needs the same scope", () => {
    expect(normalizeScopePath("/users/$count")).toBe(normalizeScopePath("/users"));
  });

  it("matches a function parameter however the source quotes it", () => {
    expect(normalizeScopePath("/definitions/filterByCurrentUser(on='{on}')"))
      .toBe(normalizeScopePath("/definitions/filterByCurrentUser(on={on})"));
  });

  it("matches a parameterless function however the source spells it", () => {
    expect(normalizeScopePath("/items/delta()")).toBe(normalizeScopePath("/items/delta"));
  });
});
