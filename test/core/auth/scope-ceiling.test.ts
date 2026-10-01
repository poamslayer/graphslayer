import { describe, expect, it } from "vitest";

import {
  classifyScope,
  DELEGATED_CONSENT_CEILING,
  READ_TEMPLATE_SCOPES,
  scopesForTemplate,
} from "../../../src/core/auth/scopes.js";

/**
 * Twenty names below the ceiling, not zero and not one.
 *
 * `DELEGATED_CONSENT_CEILING` is Entra's *approximate* cap, so a template sitting at 154 is not
 * known to be safe — it is only known to be untested. The margin has to be wide enough that a
 * batch which adds a resource family's worth of scopes goes red in CI while there is still a
 * batch's worth of room to cut, rather than going red the first time a customer clicks consent.
 * It is also wide enough for the worst case #49 sizes its shortlist against: 60 read scopes
 * doubling into 120 read-write still clears 135 with room to spare.
 */
const CONSENT_FAILURE_MARGIN = 20;

describe("scope template delegated ceiling", () => {
  it.each(["read", "read-write"] as const)("keeps the %s template below the delegated ceiling with room to react", (template) => {
    expect(scopesForTemplate(template).length).toBeLessThanOrEqual(DELEGATED_CONSENT_CEILING - CONSENT_FAILURE_MARGIN);
  });

  it.each(["read", "read-write"] as const)("keeps the %s template free of duplicates", (template) => {
    const scopes = scopesForTemplate(template);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("keeps every read-template scope classified as read", () => {
    expect(READ_TEMPLATE_SCOPES.every((scope) => classifyScope(scope) === "read")).toBe(true);
  });

  it("keeps every additional read-write-template scope classified as write", () => {
    const readScopes = new Set(scopesForTemplate("read"));
    const additionalScopes = scopesForTemplate("read-write").filter((scope) => !readScopes.has(scope));
    expect(additionalScopes.every((scope) => classifyScope(scope) === "write")).toBe(true);
  });
});
