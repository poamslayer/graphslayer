/** Reading Microsoft's OpenAPI description: references, and the response an operation succeeds with. */

export type JsonObject = Record<string, unknown>;

export interface OpenApiDocument {
  paths?: Record<string, JsonObject>;
  components?: {
    schemas?: Record<string, JsonObject>;
    parameters?: Record<string, JsonObject>;
  };
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema name a `#/components/schemas/…` reference points at, or null for anything else. */
export function schemaName(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(SCHEMA_REF_PREFIX)) return null;
  return decodeURIComponent(ref.slice(SCHEMA_REF_PREFIX.length)).replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Follow a JSON pointer local to the document. */
export function pointer(ref: unknown, document: OpenApiDocument): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;

  let value: unknown = document;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(value) || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}

/** Follow a chain of `$ref`s to the node they land on. */
export function deref(node: unknown, document: OpenApiDocument): JsonObject | undefined {
  let current = node;
  const seen = new Set<string>();

  while (isObject(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    current = pointer(current.$ref, document);
  }
  return isObject(current) ? current : undefined;
}

/**
 * The response an operation succeeds with.
 *
 * Graph's description is Kiota-generated and keys success as `2XX`, not `200`. Reading only
 * `200` — which is what an OpenAPI written by hand would use — leaves the entity type null on
 * every single path, and the build still finishes.
 */
export function successResponse(operation: unknown, document: OpenApiDocument): JsonObject | undefined {
  if (!isObject(operation)) return undefined;
  const responses = isObject(operation.responses) ? operation.responses : undefined;
  if (!responses) return undefined;

  const key = ["200", "2XX", "201", "202"].find((candidate) => candidate in responses)
    ?? Object.keys(responses).find((candidate) => candidate.startsWith("2"));
  return key === undefined ? undefined : deref(responses[key], document);
}

/** The media types a response body can come back as. */
export function responseContentTypes(response: JsonObject | undefined): string[] {
  return isObject(response?.content) ? Object.keys(response.content) : [];
}
