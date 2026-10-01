import { resolveCloud, type Cloud } from "../config.js";
import type { GraphIndex } from "./graph-index.js";
import type { IndexLoader } from "./loader.js";
import { editDistance, sameSingularOrPlural } from "./search.js";

/**
 * The index holds path templates — `/groups/{group-id}/members` — and a run calls with real ids
 * — `/groups/abc-123/members`. Everything here is the join between the two.
 */
export interface IndexPaths {
  /** The index template a called path resolves to, or undefined when the index holds no such path. */
  match(path: string): string | undefined;
  /**
   * True where the index carries Microsoft's `ConsistencyLevel` marker. Never false: the index
   * records the marker's presence and is silent otherwise, and absence only says Microsoft did
   * not mark the path, so a caller has to be able to tell "not marked" from "marked false".
   */
  consistency(path: string): true | undefined;
  /** Index templates whose one differing segment is close to the called path's. Empty when none is. */
  suggest(path: string, limit?: number): string[];
  /**
   * The fields a collection read on this path sends when the caller asked for none, or undefined
   * where the index carries no default. Undefined is the common answer: nine types carry one,
   * and every other path is left exactly as Graph would answer it.
   */
  defaultSelect(path: string): string[] | undefined;
  /** The entity type attached to the matching index path, or undefined when it carries none. */
  entityType(path: string): string | undefined;
}

interface Node {
  /** Literal segments, lower cased, because Graph does not care about a segment's case. */
  children: Map<string, Node>;
  /** The `{…}` branch, which any one segment takes. */
  wildcard?: Node;
  /** The index path that ends here. Absent on a node that only leads to others. */
  path?: string;
}

const DEFAULT_SUGGESTIONS = 3;

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function emptyNode(): Node {
  return { children: new Map() };
}

function buildTree(index: GraphIndex): Node {
  const root = emptyNode();
  for (const path of Object.keys(index.paths)) {
    let node = root;
    for (const segment of segmentsOf(path)) {
      if (isPlaceholder(segment)) node = node.wildcard ??= emptyNode();
      else {
        const key = segment.toLowerCase();
        let child = node.children.get(key);
        if (!child) node.children.set(key, (child = emptyNode()));
        node = child;
      }
    }
    node.path = path;
  }
  return root;
}

/**
 * Walks the tree literal branch first, so `/users/delta` reaches the real `/users/delta` rather
 * than being read as an id. It backtracks, because a literal branch can dead end where the
 * placeholder would have carried on: `/users/delta/messages` has no literal continuation, and
 * "delta" there is an id after all.
 */
function resolve(node: Node, segments: string[], from: number): Node | undefined {
  if (from === segments.length) return node.path !== undefined ? node : undefined;
  const literal = node.children.get(segments[from].toLowerCase());
  const viaLiteral = literal && resolve(literal, segments, from + 1);
  if (viaLiteral) return viaLiteral;
  return node.wildcard && resolve(node.wildcard, segments, from + 1);
}

/** How far into the called path the tree goes, and the node it got to. */
function deepest(node: Node, segments: string[], from: number): { node: Node; depth: number } {
  if (from === segments.length) return { node, depth: from };
  let best = { node, depth: from };
  const literal = node.children.get(segments[from].toLowerCase());
  for (const next of [literal, node.wildcard]) {
    if (!next) continue;
    const reached = deepest(next, segments, from + 1);
    if (reached.depth > best.depth) best = reached;
  }
  return best;
}

/** The paths nearest below a node, shortest first, for a prefix that leads nowhere on its own. */
function nearestBelow(node: Node, limit: number): string[] {
  const found: string[] = [];
  let level = [node];
  while (level.length > 0 && found.length < limit) {
    const next: Node[] = [];
    for (const current of level) {
      if (current.path !== undefined && current !== node) found.push(current.path);
      next.push(...current.children.values());
      if (current.wildcard) next.push(current.wildcard);
    }
    level = next;
  }
  return found.sort((left, right) => left.length - right.length || left.localeCompare(right)).slice(0, limit);
}

/**
 * How far a segment may be from one in the index and still be offered as what the caller meant.
 * A quarter of its length, at least one edit: "member" reaches "members", "frobnicate" reaches
 * nothing. Wider than this and a 404 answers with a path nobody asked about.
 */
function tolerance(segment: string): number {
  return Math.max(1, Math.ceil(segment.length / 4));
}

export function indexPaths(index: GraphIndex): IndexPaths {
  const tree = buildTree(index);

  function match(path: string): string | undefined {
    return resolve(tree, segmentsOf(path), 0)?.path;
  }

  return {
    match,

    consistency(path) {
      const template = match(path);
      return template !== undefined && index.paths[template]?.consistency ? true : undefined;
    },

    defaultSelect(path) {
      const template = match(path);
      if (template === undefined) return undefined;
      const entityType = index.paths[template]?.entityType;
      return entityType === undefined ? undefined : index.types[entityType]?.defaultSelect;
    },

    entityType(path) {
      const template = match(path);
      return template === undefined ? undefined : index.paths[template]?.entityType;
    },

    suggest(path, limit = DEFAULT_SUGGESTIONS) {
      if (limit <= 0) return [];
      const segments = segmentsOf(path);
      if (resolve(tree, segments, 0)) return [];

      const { node, depth } = deepest(tree, segments, 0);
      // Every segment resolved and the path still is not one the index holds, so the caller
      // stopped short of a real path rather than misspelling one.
      if (depth === segments.length) return nearestBelow(node, limit);

      const wanted = segments[depth].toLowerCase();
      const allowed = tolerance(wanted);
      return [...node.children]
        .flatMap(([name, child]) => {
          if (child.path === undefined) return [];
          const distance = sameSingularOrPlural(wanted, name) ? 0 : editDistance(wanted, name);
          return distance <= allowed ? [{ path: child.path, distance }] : [];
        })
        .sort((left, right) =>
          left.distance - right.distance
          || left.path.length - right.path.length
          || left.path.localeCompare(right.path))
        .slice(0, limit)
        .map((candidate) => candidate.path);
    },
  };
}

/**
 * Builds the lookup once from a loaded index and hands the same one to every caller. A load that
 * fails answers undefined rather than throwing: the index is an improvement to a Graph call, and
 * a missing one must never fail a call that would have worked without it.
 */
export function createIndexPaths(load: IndexLoader): (cloud?: Cloud) => Promise<IndexPaths | undefined> {
  const built = new Map<Cloud, Promise<IndexPaths | undefined>>();

  return (requestedCloud) => {
    const cloud = resolveCloud(requestedCloud);
    let result = built.get(cloud);
    if (!result) {
      const attempt = load(cloud).then(
        ({ index }) => indexPaths(index),
        () => undefined,
      );
      built.set(cloud, attempt);
      result = attempt;
    }
    return result;
  };
}
