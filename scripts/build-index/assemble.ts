/**
 * Assembling the Graph index: one entry per path, and one shared table of types.
 *
 * The shape is forced rather than chosen. Inlining every `$ref` the way Cloudflare's spec
 * processor does cannot be built on Graph — measured on a 310-path sample of v1.0, 21 paths
 * exceed the whole 64 MiB isolate budget on their own and the description projects to about
 * 16 GB, because every directory object reaches `microsoft.graph.entity` and drags the
 * transitive closure with it. A shared type table is the only shape that fits. See README.md.
 */

import { needsConsistencyHeader } from "./consistency.ts";
import { readTypes, type TypeEntry } from "./csdl.ts";
import { CURATED_DEFAULT_SELECT, curatedProblems } from "./default-select.ts";
import { entityTypeForOperation } from "./entity-type.ts";
import { isObject, type OpenApiDocument } from "./openapi.ts";
import { untypedPathKind, type UntypedPathKind } from "./path-kind.ts";
import { type ScopeIndex, type ScopeSet, scopesFor } from "./scopes.ts";
import type { GraphApiVersion, GraphIndex, PathEntry } from "../../src/core/index/graph-index.ts";

export type { GraphApiVersion, GraphIndex, PathEntry } from "../../src/core/index/graph-index.ts";

/** Half of the measured 63 MB an object literal can occupy inside a `workerd` isolate. */
export const INDEX_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

/** Where a built index lands. Only v1.0 is committed and published. */
export function indexFileName(version: GraphApiVersion): string {
  return version === "v1.0" ? "graph-index.json" : `graph-index-${version}.json`;
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface BuildReport {
  paths: number;
  typedPaths: number;
  untypedByKind: Partial<Record<UntypedPathKind, number>>;
  /** Untyped paths that fit no known kind. A non-empty list is a build to look at, not a build to ship. */
  unclassifiedPaths: string[];
  types: number;
  /**
   * Type names a path's GET resolved to that are neither in `types` nor a known enum. Like
   * `unclassifiedPaths`, a non-empty list is an alarm rather than a note.
   */
  unresolvedEntityTypes: string[];
  consistencyPaths: number;
  scopeCoverage: { paths: number; matched: number };
  /** Types given a curated default `$select`, and the paths that reach one through `entityType`. */
  defaultSelect: { types: number; paths: number };
}

export interface AssembleInput {
  version: GraphApiVersion;
  builtAt: string;
  openapi: OpenApiDocument;
  csdl: string;
  scopes: ScopeIndex;
  /**
   * The curated default `$select`, overridable so a test can hand a table that matches its own
   * small CSDL. A real build never passes this: it takes `CURATED_DEFAULT_SELECT` and every name
   * in it has to be a real property of a real type or the build fails.
   */
  curatedDefaultSelect?: Record<string, string[]>;
}

export function assembleIndex({
  version,
  builtAt,
  openapi,
  csdl,
  scopes,
  curatedDefaultSelect = CURATED_DEFAULT_SELECT,
}: AssembleInput): {
  index: GraphIndex;
  report: BuildReport;
} {
  const { types, enums } = readTypes(csdl);
  const enumEntries = Object.fromEntries(enums);

  // A curated name that is not a real property would put a `$select` on the wire that Graph
  // rejects, on the busiest reads there are. Failing the build is the guard that lets a
  // hand-kept list be trusted at all, so this throws rather than warns.
  const problems = curatedProblems(types, curatedDefaultSelect);
  if (problems.length > 0) {
    const detail = problems.map(({ type, missing }) => `${type}: ${missing.join(", ")}`).join("; ");
    throw new Error(`The curated default $select names properties that ${version} does not have. ${detail}`);
  }
  for (const [type, properties] of Object.entries(curatedDefaultSelect)) types[type].defaultSelect = [...properties];

  const paths: Record<string, PathEntry> = {};

  const untypedByKind: Partial<Record<UntypedPathKind, number>> = {};
  const unclassifiedPaths: string[] = [];
  const unresolvedTypes = new Set<string>();
  let typedPaths = 0;
  let consistencyPaths = 0;
  let matchedScopePaths = 0;

  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    const methods = HTTP_METHODS.filter((method) => isObject(pathItem[method]));
    if (methods.length === 0) continue;

    const resolvedName = isObject(pathItem.get) ? entityTypeForOperation(pathItem.get, openapi) : null;
    // Only a name the types table can hold goes in, so every entityType a consumer reads
    // resolves. An enum is a legitimate return with no properties; anything else is a gap.
    const entityType = resolvedName !== null && types[resolvedName] ? resolvedName : null;
    if (resolvedName !== null && entityType === null && !enums.has(resolvedName)) unresolvedTypes.add(resolvedName);
    const consistency = needsConsistencyHeader(pathItem, openapi);
    const byMethod: Record<string, ScopeSet> = {};
    for (const method of methods) {
      const found = scopesFor(scopes, path, method);
      if (found) byMethod[method] = found;
    }

    const entry: PathEntry = { methods: [...methods] };
    if (consistency) entry.consistency = true;
    if (entityType !== null) entry.entityType = entityType;
    if (Object.keys(byMethod).length > 0) entry.scopes = byMethod;
    paths[path] = entry;

    if (entityType === null) {
      const kind = resolvedName !== null && enums.has(resolvedName) ? "enum" : untypedPathKind(path, pathItem, openapi);
      untypedByKind[kind] = (untypedByKind[kind] ?? 0) + 1;
      if (kind === "unclassified") unclassifiedPaths.push(path);
    } else {
      typedPaths += 1;
    }
    if (consistency) consistencyPaths += 1;
    if (entry.scopes) matchedScopePaths += 1;
  }

  return {
    index: { version, builtAt, types, enums: enumEntries, paths },
    report: {
      paths: Object.keys(paths).length,
      typedPaths,
      untypedByKind,
      unclassifiedPaths,
      types: Object.keys(types).length,
      unresolvedEntityTypes: [...unresolvedTypes].sort(),
      consistencyPaths,
      scopeCoverage: { paths: Object.keys(paths).length, matched: matchedScopePaths },
      defaultSelect: {
        types: Object.keys(curatedDefaultSelect).length,
        paths: Object.values(paths).filter((entry) => entry.entityType !== undefined
          && types[entry.entityType]?.defaultSelect !== undefined).length,
      },
    },
  };
}
