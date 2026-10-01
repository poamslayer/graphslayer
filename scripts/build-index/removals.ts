import type { GraphIndex } from "../../src/core/index/graph-index.ts";
import { readTypes } from "./csdl.ts";

function pathPrefixes(path: string): string[] {
  const prefixes: string[] = [];
  let prefix = "";
  for (const segment of path.split("/").filter(Boolean)) {
    prefix += `/${segment}`;
    prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * Derive the strictly subtractive Gov path surface from the commercial index and both schemas.
 *
 * This catches schema-level absence only. Permission-level gaps (the path exists but the scope
 * does not) and product-feature gaps such as unavailable Intune features are invisible to the
 * CSDL and are deliberately not handled here.
 */
export function deriveGovRemovals(index: GraphIndex, commercialCsdl: string, govCsdl: string): string[] {
  const commercial = readTypes(commercialCsdl);
  const gov = readTypes(govCsdl);
  const removed: string[] = [];

  for (const path of Object.keys(index.paths)) {
    const root = path.split("/").find(Boolean);
    if (root && commercial.roots.has(root) && !gov.roots.has(root)) {
      removed.push(path);
      continue;
    }

    const terminal = path.slice(path.lastIndexOf("/") + 1).split("(", 1)[0];
    if (commercial.operations.has(terminal) && !gov.operations.has(terminal)) {
      removed.push(path);
      continue;
    }

    const traversed = pathPrefixes(path).flatMap((prefix) => {
      const type = index.paths[prefix]?.entityType;
      return type && commercial.entityTypes.has(type) ? [type] : [];
    });
    if (traversed.some((type) => !gov.entityTypes.has(type))) removed.push(path);
  }

  return removed.sort();
}
