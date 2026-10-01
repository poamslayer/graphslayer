import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  classifyScope,
  modeForTemplate,
  readScopeName,
  READ_TEMPLATE_SCOPES,
  READ_WRITE_TEMPLATE_SCOPES,
  scopesForTemplate,
} from "../../../src/core/auth/scopes.js";
import type { GraphIndex, ScopeFamily } from "../../../src/core/index/graph-index.js";

const UNCLASSIFIED_SCOPES = [
  "Calls.AccessMedia.All",
  "Calls.Initiate.All",
  "Calls.InitiateGroupCall.All",
  "Calls.JoinGroupCall.All",
  "Calls.JoinGroupCallAsGuest.All",
  "Calls.JoinGroupCallasGuest.All",
  "Calls.JoinGroupCalls.Chat",
  "Content.Process.All",
  "Content.Process.User",
  "DeviceManagementManagedDevices.PrivilegedOperations.All",
  "Directory.AccessAsUser.All",
  "EduReports-Reading.ReadAnonymous.All",
  "EduReports-Reflect.ReadAnonymous.All",
  "EngagementConversation.Migration.All",
  "FileStorageContainer.Selected",
  "Printer.FullControl.All",
  "ProtectionScopes.Compute.All",
  "ProtectionScopes.Compute.User",
  "ResourceSpecificPermissionGrant.ReadForChat",
  "ResourceSpecificPermissionGrant.ReadForChat.All",
  "ResourceSpecificPermissionGrant.ReadForTeam",
  "ResourceSpecificPermissionGrant.ReadForTeam.All",
  "ResourceSpecificPermissionGrant.ReadForUser",
  "ResourceSpecificPermissionGrant.ReadForUser.All",
  "SensitivityLabel.Evaluate",
  "SensitivityLabel.Evaluate.All",
  "Sites.FullControl.All",
  "Sites.Selected",
  "TeamsAppInstallation.ReadForChat",
  "TeamsAppInstallation.ReadForChat.All",
  "TeamsAppInstallation.ReadForTeam",
  "TeamsAppInstallation.ReadForTeam.All",
  "TeamsAppInstallation.ReadForUser",
  "TeamsAppInstallation.ReadForUser.All",
  "Teamwork.Migrate.All",
  "User.EnableDisableAccount.All",
];

function addFamilyScopes(names: Set<string>, family?: ScopeFamily): void {
  if (!family) return;
  for (const name of family.least ?? []) names.add(name);
  for (const name of family.all) names.add(name);
  for (const [name, requirements] of Object.entries(family.alsoRequires ?? {})) {
    names.add(name);
    for (const requirement of requirements) names.add(requirement);
  }
}

/** Every distinct scope name the shipped v1.0 index mentions, from both families. */
async function shippedScopeNames(): Promise<Set<string>> {
  const file = new URL("../../../data/graph-index.json", import.meta.url);
  const index = JSON.parse(await readFile(file, "utf8")) as GraphIndex;
  const names = new Set<string>();
  for (const path of Object.values(index.paths)) {
    for (const scopes of Object.values(path.scopes ?? {})) {
      addFamilyScopes(names, scopes.delegated);
      addFamilyScopes(names, scopes.application);
    }
  }
  return names;
}

describe("scope templates", () => {
  it.each(READ_TEMPLATE_SCOPES)("classifies read-template scope %s as read", (scope) => {
    expect(classifyScope(scope)).toBe("read");
  });

  const writeTemplateScopes = READ_WRITE_TEMPLATE_SCOPES.filter((scope) => !READ_TEMPLATE_SCOPES.includes(scope));
  it.each(writeTemplateScopes)("classifies write-template scope %s as write", (scope) => {
    expect(classifyScope(scope)).toBe("write");
  });

  it.each(UNCLASSIFIED_SCOPES)("reads %s as unclassified and counts it as a write", (scope) => {
    // Asserting the reading, not only the classification: a write marker that silently swallowed
    // one of these would still classify it as a write and this test would not notice.
    expect(readScopeName(scope)).toBe("unclassified");
    expect(classifyScope(scope)).toBe("write");
  });

  it("finds exactly the 36 unclassified names in the shipped index, and no others", async () => {
    const names = await shippedScopeNames();
    expect([...names].filter((name) => readScopeName(name) === "unclassified").sort()).toEqual(
      [...UNCLASSIFIED_SCOPES].sort(),
    );
  });

  it.each([
    ["User.Read", "read"],
    ["User.ReadBasic.All", "read"],
    ["User.ReadWrite.All", "write"],
    ["Directory.AccessAsUser.All", "write"],
    ["openid", "write"],
    ["", "write"],
    ["NotAScopeName", "write"],
  ] as const)("classifies %j as %s", (scope, expected) => {
    expect(classifyScope(scope)).toBe(expected);
  });

  it("classifies exactly 281 distinct names in the shipped index as read", async () => {
    const names = await shippedScopeNames();

    // A rebuilt index changing this count is a classification review signal, not test noise.
    expect([...names].filter((name) => classifyScope(name) === "read")).toHaveLength(281);
  });

  it("derives a write counterpart only where the index actually holds one", async () => {
    const names = await shippedScopeNames();
    const derivable = READ_TEMPLATE_SCOPES.map((scope) => {
      const segments = scope.split(".");
      segments[1] = "ReadWrite";
      return segments.join(".");
    }).filter((scope) => names.has(scope));

    // The module keeps its own copy of this set so it never parses four megabytes at import.
    // This is the test that catches the copy drifting from the index it mirrors.
    expect(READ_WRITE_TEMPLATE_SCOPES).toEqual(expect.arrayContaining(derivable));
    expect(derivable).not.toContain("Policy.ReadWrite.All");
    expect(derivable).not.toContain("AuditLog.ReadWrite.All");
  });

  it("makes the read-write template a superset of the read template", () => {
    expect(scopesForTemplate("read-write")).toEqual(expect.arrayContaining(scopesForTemplate("read")));
  });

  it.each([
    ["read", "read"],
    ["read-write", "write"],
  ] as const)("maps the %s template to %s mode", (template, mode) => {
    expect(modeForTemplate(template)).toBe(mode);
  });
});
