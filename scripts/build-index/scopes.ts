/**
 * The least privileged delegated and application scopes for a path and method, joined from
 * Microsoft's permissions reference.
 *
 * The join is partial and known to be: it resolves 31% of v1.0 paths and fails in both
 * directions. That headline is the wrong measure, though. Coverage is 62% of the reads at one
 * or two literal segments and 100% of the 26 entry points an assessment actually uses, and it
 * collapses to 0.7% at six segments deep, which is most of Graph and none of the traffic.
 *
 * What this module owes the rest of the build is honesty about the gap, which it keeps by
 * never writing an empty thing down. A path
 * the reference does not cover has no entry, a family it grants nothing under is absent, and
 * `least` is absent when the reference marks none — so there is no shape a consumer can read
 * as "no scope is needed" unless that is what the reference actually says.
 */

import type { ScopeFamily, ScopeSet } from "../../src/core/index/graph-index.ts";

export type { ScopeFamily, ScopeSet } from "../../src/core/index/graph-index.ts";

export type ScopeIndex = Map<string, Map<string, ScopeSet>>;

type FamilyName = "delegated" | "application";

interface DraftFamily {
  least: Set<string>;
  all: Set<string>;
  alsoRequires: Map<string, Set<string>>;
}

interface PathSet {
  schemeKeys?: string[];
  methods?: string[];
  paths?: Record<string, string>;
}

interface Permission {
  schemes?: Record<string, unknown>;
  pathSets?: PathSet[];
}

/**
 * Rewrite a path into the one spelling both sources can be looked up by.
 *
 * Lowercase and a single `{id}` placeholder were the whole of this, and joined 2,217 of 11,546
 * v1.0 paths. The four rules below take it to 3,615, a 63% relative gain for four regular
 * expressions. Each was measured on its own; see `docs/research/2026-09-16-permissions-join.md`.
 *
 *   unquote a function parameter   on='{id}' against on={id}                  +125 paths
 *   drop a trailing type cast      /members/{id}/graph.application            +256 paths
 *   drop a trailing OData segment  /members/$ref against /members             +907 paths
 *   drop empty parentheses         delta() against delta                      +110 paths
 *
 * The cast rule matches the **alias** spelling only, `graph.user`, and deliberately not
 * `microsoft.graph.security.moveAlerts`. Those are not casts, they are namespaced actions, and
 * stripping one hands the action whatever the collection beneath it is granted. Measured before
 * the anchor was tightened: `/security/alerts_v2/microsoft.graph.security.moveAlerts` inherited
 * `SecurityAlert.Create.All` from `/security/alerts_v2`, which the reference says nothing about,
 * and four eDiscovery hold actions inherited theirs the same way. Creating an alert and moving
 * one are different operations, and a scope the reference never stated is exactly the confident
 * wrong answer this module exists to avoid.
 *
 * The split is clean and was checked rather than assumed. In v1.0 all 300 trailing `graph.<name>`
 * segments are type casts and all 78 `microsoft.graph.<namespace>.<name>` segments are not. Beta
 * has 370 and 203, of which two are genuinely casts: those two now fail to join, which is the
 * safe direction, because a missing scope reads as unknown and a wrong one reads as fact.
 *
 * The third is the large one and it is also the one worth justifying. A `$count` on a collection
 * needs the same scope as the collection, and `$ref` and `$value` are the same read addressed
 * differently, so folding them onto the collection is correct rather than merely convenient.
 *
 * What is deliberately not here is suffix matching, which would fix the 105 paths where the
 * reference uses a shorter vocabulary than the description — `/accessreviews` against
 * `/identityGovernance/accessReviews`. A tail like `/members/{id}` is shared by resources with
 * different scopes, so it would sometimes put a confidently wrong scope name in front of a
 * person. Unknown is better than wrong here.
 *
 * None of this closes the gap, and it is not meant to. 85% of the reference paths that miss are
 * beta-only or name features neither description has published yet, which no normalization
 * reaches.
 */
export function normalizeScopePath(path: string): string {
  return path
    .toLowerCase()
    .replace(/\{[^/{}]+\}/g, "{id}")
    .replace(/='\{id\}'/g, "={id}")
    .replace(/\/graph\.[a-z0-9]+$/, "")
    .replace(/\/\$(ref|value|count)$/, "")
    .replace(/\(\)$/, "");
}

function familyOf(scheme: string): FamilyName {
  return scheme.toLowerCase().includes("application") ? "application" : "delegated";
}

function annotationValues(annotation: string, key: string): string[] {
  const match = annotation.match(new RegExp(`(?:^|[;&\\s])${key}=([^;&]*)`, "i"));
  if (!match?.[1].trim()) return [];
  return match[1].split(",").map((item) => item.trim()).filter(Boolean);
}

function emptyDraft(): Record<FamilyName, DraftFamily> {
  return {
    delegated: { least: new Set(), all: new Set(), alsoRequires: new Map() },
    application: { least: new Set(), all: new Set(), alsoRequires: new Map() },
  };
}

function finishFamily(draft: DraftFamily): ScopeFamily | undefined {
  if (draft.all.size === 0) return undefined;

  const family: ScopeFamily = { all: [...draft.all].sort() };
  if (draft.least.size > 0) family.least = [...draft.least].sort();
  if (draft.alsoRequires.size > 0) {
    family.alsoRequires = Object.fromEntries(
      [...draft.alsoRequires].sort(([a], [b]) => a.localeCompare(b)).map(([scope, needs]) => [scope, [...needs].sort()]),
    );
  }
  // `least` first when present, so the file reads the way a person asks the question.
  return family.least ? { least: family.least, all: family.all, ...(family.alsoRequires ? { alsoRequires: family.alsoRequires } : {}) } : family;
}

/** Index Microsoft's permissions reference by normalized path and lowercase method. */
export function readScopes(document: unknown): ScopeIndex {
  const permissions = (document as { permissions?: Record<string, Permission> }).permissions ?? {};
  const drafts = new Map<string, Map<string, Record<FamilyName, DraftFamily>>>();

  for (const [scopeName, permission] of Object.entries(permissions)) {
    for (const pathSet of permission.pathSets ?? []) {
      const schemes = pathSet.schemeKeys ?? Object.keys(permission.schemes ?? {});

      for (const [rawPath, annotation] of Object.entries(pathSet.paths ?? {})) {
        const path = normalizeScopePath(rawPath);
        const leastSchemes = new Set(annotationValues(annotation ?? "", "least"));
        const alsoRequires = annotationValues(annotation ?? "", "AlsoRequires");
        let byMethod = drafts.get(path);
        if (!byMethod) drafts.set(path, (byMethod = new Map()));

        for (const rawMethod of pathSet.methods ?? []) {
          const method = rawMethod.toLowerCase();
          let draft = byMethod.get(method);
          if (!draft) byMethod.set(method, (draft = emptyDraft()));

          for (const scheme of schemes) {
            const family = draft[familyOf(scheme)];
            family.all.add(scopeName);
            if (leastSchemes.has(scheme)) family.least.add(scopeName);
            if (alsoRequires.length > 0) {
              const needs = family.alsoRequires.get(scopeName) ?? new Set<string>();
              for (const need of alsoRequires) needs.add(need);
              family.alsoRequires.set(scopeName, needs);
            }
          }
        }
      }
    }
  }

  const index: ScopeIndex = new Map();
  for (const [path, byMethod] of drafts) {
    const methods = new Map<string, ScopeSet>();
    for (const [method, draft] of byMethod) {
      const delegated = finishFamily(draft.delegated);
      const application = finishFamily(draft.application);
      if (!delegated && !application) continue;
      methods.set(method, { ...(delegated ? { delegated } : {}), ...(application ? { application } : {}) });
    }
    if (methods.size > 0) index.set(path, methods);
  }
  return index;
}

/** The scopes for one call, or undefined when the reference says nothing about it. */
export function scopesFor(index: ScopeIndex, path: string, method: string): ScopeSet | undefined {
  return index.get(normalizeScopePath(path))?.get(method.toLowerCase());
}
