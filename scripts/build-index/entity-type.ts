/**
 * Which entity type a Graph path returns.
 *
 * Two shapes in Microsoft's description make the obvious reading wrong, and both fail
 * silently — the index still builds, it just carries no types. See README.md.
 */

import { deref, isObject, type JsonObject, type OpenApiDocument, schemaName, successResponse } from "./openapi.ts";

/**
 * Schemas that wrap the entity rather than being it. A Graph collection is
 *   allOf: [ { $ref: BaseCollectionPaginationCountResponse },
 *            { properties: { value: { items: { $ref: microsoft.graph.user } } } } ]
 * so a walk that takes the first allOf branch stops at the envelope and never reaches the
 * entity. Naming these, and looking for `value` before taking a branch, is what keeps
 * `/users` resolving to `microsoft.graph.user`.
 *
 * The list is exactly these three names and not a `CollectionResponse` suffix rule. A
 * collection envelope is recognised by carrying `value`, which is checked first, so the
 * suffix adds nothing — and it is wrong: `microsoft.graph.deviceLogCollectionResponse` is a
 * real entity type in the CSDL, and a suffix rule quietly resolved its item paths to
 * `microsoft.graph.entity` instead.
 */
const ENVELOPE_NAMES = new Set([
  "BaseCollectionPaginationCountResponse",
  "ODataCountResponse",
  "BaseDeltaFunctionResponse",
]);

function isEnvelope(name: string): boolean {
  return ENVELOPE_NAMES.has(name);
}

function branchesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function responseSchema(response: JsonObject): unknown {
  const content = isObject(response.content) ? response.content : undefined;
  if (!content) return undefined;

  const body = content["application/json"] ?? Object.values(content)[0];
  return isObject(body) ? body.schema : undefined;
}

/**
 * Whether a schema is a collection, and the name of what it holds.
 *
 * Carrying `value` is what makes a schema a collection, so once that is found the answer is
 * the item name or nothing — never the wrapper's own name. `StringCollectionResponse` holds
 * bare strings, and falling through to the wrapper would record it as an entity type that no
 * types table can hold.
 */
function collectionItem(schema: JsonObject, document: OpenApiDocument): { isCollection: boolean; name: string | null } {
  const branches = [schema, ...branchesOf(schema.allOf), ...branchesOf(schema.anyOf)];

  for (const branch of branches) {
    const resolved = deref(branch, document);
    const properties = isObject(resolved?.properties) ? resolved.properties : undefined;
    const value = deref(properties?.value, document);
    if (!value || value.type !== "array") continue;

    const name = schemaName(isObject(value.items) ? value.items.$ref : undefined)
      ?? schemaName(deref(value.items, document)?.$ref);
    return { isCollection: true, name };
  }
  return { isCollection: false, name: null };
}

function entityTypeForSchema(schema: unknown, document: OpenApiDocument, seen: Set<string>): string | null {
  if (schema === undefined || schema === null) return null;

  const directName = schemaName(isObject(schema) ? schema.$ref : undefined);
  if (directName !== null) {
    if (seen.has(directName)) return null;
    seen.add(directName);
  }

  const resolved = deref(schema, document);
  if (!resolved) return directName !== null && !isEnvelope(directName) ? directName : null;

  const collection = collectionItem(resolved, document);
  if (collection.isCollection) return collection.name;

  if (resolved.type === "array") {
    const name = schemaName(isObject(resolved.items) ? resolved.items.$ref : undefined);
    if (name) return name;
  }

  if (directName !== null && !isEnvelope(directName)) return directName;

  // `anyOf` before `allOf`: Graph writes a nullable single entity as
  // `anyOf: [ { $ref: microsoft.graph.workbookRange }, { type: object, nullable: true } ]`,
  // and the nullable branch carries no name, so it recurses to null and the ref wins.
  for (const branch of [...branchesOf(resolved.anyOf), ...branchesOf(resolved.oneOf), ...branchesOf(resolved.allOf)]) {
    const found = entityTypeForSchema(branch, document, seen);
    if (found !== null && !isEnvelope(found)) return found;
  }
  return null;
}

/** The entity type an operation's success response carries, or null when it carries none. */
export function entityTypeForOperation(operation: unknown, document: OpenApiDocument): string | null {
  const response = successResponse(operation, document);
  if (!response) return null;

  const schema = responseSchema(response);
  if (schema === undefined) return null;

  return entityTypeForSchema(schema, document, new Set());
}
