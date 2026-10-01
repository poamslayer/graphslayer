/**
 * Whether advanced queries on a path need `ConsistencyLevel: eventual`.
 *
 * Microsoft publishes this rather than leaving it to be guessed: Kiota emits a
 * `ConsistencyLevel` header parameter on the operations it marks as requiring the header, with
 * a description pointing at the advanced-queries documentation. Reading the marker beats a
 * hand-kept list of directory path prefixes, which is both wider than the truth in places
 * (`/directoryRoles` carries no marker) and narrower in others (every `memberOf` collection
 * under `/me` carries one).
 *
 * The marker proves the header is needed. Its absence does not prove the opposite: Microsoft
 * documents advanced-query cases for administrative units, and `/directory/administrativeUnits`
 * carries no marker. That is why the index records the flag only when it is true and leaves an
 * unmarked path with no key at all, rather than writing down a `false` it cannot stand behind.
 */

import { deref, isObject, type JsonObject, type OpenApiDocument } from "./openapi.ts";

const CONSISTENCY_PARAMETER = "ConsistencyLevel";

function parametersOf(pathItem: JsonObject, operation: JsonObject, document: OpenApiDocument): JsonObject[] {
  const declared = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];

  return declared.flatMap((parameter) => {
    const resolved = deref(parameter, document);
    return resolved ? [resolved] : [];
  });
}

/** True when the path's GET declares the header parameter Graph requires for advanced queries. */
export function needsConsistencyHeader(pathItem: JsonObject, document: OpenApiDocument): boolean {
  const operation = isObject(pathItem.get) ? pathItem.get : undefined;
  if (!operation) return false;

  return parametersOf(pathItem, operation, document)
    .some((parameter) => parameter.name === CONSISTENCY_PARAMETER && parameter.in === "header");
}
