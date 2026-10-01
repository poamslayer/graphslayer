/**
 * The shared `types` table, read from Microsoft's CSDL metadata.
 *
 * The CSDL is the file the OpenAPI is generated from. It is 3.6 MB against 44 MB, parses in a
 * tenth of a second, and yields a tighter table for the same paths, so it is the type source
 * even though the paths come from the OpenAPI. See README.md.
 */

import { XMLParser } from "fast-xml-parser";
import type { EnumEntry, TypeEntry } from "../../src/core/index/graph-index.ts";

export type { EnumEntry, TypeEntry } from "../../src/core/index/graph-index.ts";

export interface CsdlTypes {
  types: Record<string, TypeEntry>;
  /** The structured types declared as entities rather than complex types. */
  entityTypes: Set<string>;
  /** Top-level entity sets and singletons, keyed by their path segment. */
  roots: Map<string, string>;
  /** Action and function declarations, keyed by both bare and namespace-qualified names. */
  operations: Set<string>;
  /** Type name to the type it derives from, for the types that derive from one. */
  baseOf: Map<string, string>;
  /**
   * Enum entries keyed by type name. They remain separate from `types` because they have
   * members rather than properties. Keeping them in a Map lets path classification distinguish
   * a legitimate enum from a type it failed to resolve without a second lookup structure.
   */
  enums: Map<string, EnumEntry>;
}

interface CsdlProperty {
  Name?: string;
  Type?: string;
}

interface CsdlStructuredType {
  Name?: string;
  BaseType?: string;
  Property?: CsdlProperty[];
  NavigationProperty?: CsdlProperty[];
}

interface CsdlEnumType {
  Name?: string;
  IsFlags?: string;
  Member?: Array<{ Name?: string }>;
}

interface CsdlOperation {
  Name?: string;
}

interface CsdlSchema {
  Namespace?: string;
  Alias?: string;
  EntityType?: CsdlStructuredType[];
  ComplexType?: CsdlStructuredType[];
  EnumType?: CsdlEnumType[];
  Action?: CsdlOperation[];
  Function?: CsdlOperation[];
  EntityContainer?: Array<{
    EntitySet?: Array<{ Name?: string; EntityType?: string | string[] }>;
    Singleton?: Array<{ Name?: string; Type?: string }>;
  }>;
}

const ALWAYS_ARRAY = new Set([
  "Schema", "EntityType", "ComplexType", "EnumType", "Member", "Property", "NavigationProperty",
  "Action", "Function", "EntityContainer", "EntitySet", "Singleton",
]);

function asArray<T>(value: T[] | undefined): T[] {
  return value ?? [];
}

function scalar(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function schemasOf(document: unknown): CsdlSchema[] {
  const root = (document as { Edmx?: { DataServices?: { Schema?: CsdlSchema[] } } }).Edmx;
  return asArray(root?.DataServices?.Schema);
}

/**
 * Rewrite a type reference from a schema alias to the namespace the table is keyed by.
 *
 * Five of v1.0's eleven schemas declare one, including the two that matter most:
 * `microsoft.graph` is written `graph` and `microsoft.graph.security` is written `self`.
 * References to those namespaces use the alias, and there are 8,190 of them. The six schemas
 * with no alias are referenced by their full namespace and pass through untouched.
 *
 * Leaving an alias alone breaks the table in two silent ways: `BaseType="graph.directoryObject"`
 * finds nothing, so `microsoft.graph.user` loses `id` and every other inherited property, and a
 * property typed `graph.signInActivity` names a key the table does not have.
 */
function resolveAliases(type: string, namespaceOf: Map<string, string>): string {
  const collection = type.match(/^Collection\((.*)\)$/);
  if (collection) return `Collection(${resolveAliases(collection[1], namespaceOf)})`;

  const lastDot = type.lastIndexOf(".");
  if (lastDot === -1) return type;

  const namespace = namespaceOf.get(type.slice(0, lastDot));
  return namespace === undefined ? type : `${namespace}${type.slice(lastDot)}`;
}

/** Read structured types and enums out of a CSDL document, with structured inheritance flattened. */
export function readTypes(xml: string): CsdlTypes {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (tagName) => ALWAYS_ARRAY.has(tagName),
  });

  const schemas = schemasOf(parser.parse(xml));
  // An alias is declared per schema but usable anywhere in the document, so collect them first.
  const namespaceOf = new Map<string, string>();
  for (const schema of schemas) {
    if (schema.Alias && schema.Namespace) namespaceOf.set(schema.Alias, schema.Namespace);
  }

  const enums = new Map<string, EnumEntry>();
  for (const schema of schemas) {
    for (const element of asArray(schema.EnumType)) {
      const members = asArray(element.Member).flatMap((member) => (member.Name === undefined ? [] : [member.Name]));
      enums.set(`${schema.Namespace}.${element.Name}`, {
        members,
        ...(element.IsFlags === "true" ? { isFlags: true } : {}),
      });
    }
  }

  const declared = new Map<string, { base?: string; properties: Record<string, string> }>();
  const entityTypes = new Set<string>();

  for (const schema of schemas) {
    for (const element of asArray(schema.EntityType)) {
      if (element.Name) entityTypes.add(`${schema.Namespace}.${element.Name}`);
    }
    for (const element of [...asArray(schema.EntityType), ...asArray(schema.ComplexType)]) {
      const properties: Record<string, string> = {};
      for (const property of [...asArray(element.Property), ...asArray(element.NavigationProperty)]) {
        if (property.Name && property.Type) properties[property.Name] = resolveAliases(property.Type, namespaceOf);
      }
      declared.set(`${schema.Namespace}.${element.Name}`, {
        base: element.BaseType === undefined ? undefined : resolveAliases(element.BaseType, namespaceOf),
        properties,
      });
    }
  }

  const flattened = new Map<string, Record<string, string>>();

  function flatten(name: string, chain: Set<string>): Record<string, string> {
    const cached = flattened.get(name);
    if (cached) return cached;
    if (chain.has(name)) return {};

    chain.add(name);
    const current = declared.get(name);
    const inherited = current?.base ? flatten(current.base, chain) : {};
    const properties = { ...inherited, ...current?.properties };
    chain.delete(name);

    flattened.set(name, properties);
    return properties;
  }

  const types: Record<string, TypeEntry> = {};
  const baseOf = new Map<string, string>();
  for (const [name, entry] of declared) {
    types[name] = { properties: flatten(name, new Set()) };
    if (entry.base) baseOf.set(name, entry.base);
  }

  const roots = new Map<string, string>();
  for (const schema of schemas) {
    for (const container of asArray(schema.EntityContainer)) {
      for (const root of asArray(container.EntitySet)) {
        const type = scalar(root.EntityType);
        if (root.Name && type) roots.set(root.Name, resolveAliases(type, namespaceOf));
      }
      for (const root of asArray(container.Singleton)) {
        if (root.Name && root.Type) roots.set(root.Name, resolveAliases(root.Type, namespaceOf));
      }
    }
  }

  const operations = new Set<string>();
  for (const schema of schemas) {
    for (const operation of [...asArray(schema.Action), ...asArray(schema.Function)]) {
      if (!operation.Name) continue;
      operations.add(operation.Name);
      if (schema.Namespace) operations.add(`${schema.Namespace}.${operation.Name}`);
    }
  }

  return { types, entityTypes, roots, operations, baseOf, enums };
}

/** The named type and every type that reaches it through a chain of `BaseType`s. */
export function typesDerivedFrom({ types, baseOf }: CsdlTypes, root: string): Set<string> {
  const derived = new Set<string>();

  for (const name of Object.keys(types)) {
    const chain = new Set<string>();
    let current: string | undefined = name;

    while (current !== undefined && !chain.has(current)) {
      if (current === root) {
        derived.add(name);
        break;
      }
      chain.add(current);
      current = baseOf.get(current);
    }
  }
  return derived;
}
