/**
 * Why a path has no entity type.
 *
 * About 41% of v1.0 paths resolve no entity, and that is expected — a `$count` returns an
 * integer, a photo returns bytes, a path with no GET has no read to take a type from. The
 * point of naming the kinds is the leftover: a path that fits none of them is either a
 * resolver bug or a shape Microsoft has started using, and the build has to say so out loud
 * rather than drop it.
 *
 * The buckets are about the path's shape, not a claim about its nature. `action` means only
 * that there is no GET, and most of those are actions — but `/places` is a write-only resource
 * that lands there too. A bucket must never become somewhere resolver failures can hide: the
 * `function` bucket held 697 paths whose response was a nullable `anyOf` until the resolver
 * learned to read through one, and nothing in the counts said so.
 */

import { type JsonObject, type OpenApiDocument, responseContentTypes, successResponse } from "./openapi.ts";

export type UntypedPathKind = "count" | "ref" | "function" | "action" | "media" | "enum" | "unclassified";

function lastSegment(path: string): string {
  const segments = path.replace(/\/$/, "").split("/");
  return segments[segments.length - 1] ?? "";
}

/** Which kind of path this is, for a path whose GET resolved no entity type. */
export function untypedPathKind(path: string, pathItem: JsonObject, document: OpenApiDocument): UntypedPathKind {
  const segment = lastSegment(path);
  if (segment === "$count") return "count";
  if (segment === "$ref") return "ref";
  if (segment.includes("(")) return "function";
  if (pathItem.get === undefined) return "action";

  const contentTypes = responseContentTypes(successResponse(pathItem.get, document));
  if (contentTypes.length > 0 && !contentTypes.includes("application/json")) return "media";

  return "unclassified";
}
