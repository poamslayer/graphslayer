import type { GraphIndex, PathEntry } from "./graph-index.js";

export interface PathMatch {
  path: string;
  entry: PathEntry;
  score: number;
  matchedOn: string;
}

export interface SearchResult {
  matches: PathMatch[];
  closest: string[];
}

interface ClosestCandidate {
  path: string;
  overlap: number;
  distance: number;
  depth: number;
}

interface ClosestSource {
  path: string;
  segments: string[];
}

// This is a heuristic pinned by tests, not a claim the sources make.
const PROMINENT_ROOTS = new Set([
  "users",
  "groups",
  "me",
  "applications",
  "serviceprincipals",
  "devices",
  "directoryroles",
  "directoryobjects",
  "identity",
  "policies",
  "security",
  "auditlogs",
  "reports",
  "organization",
  "domains",
]);

export function sameSingularOrPlural(left: string, right: string): boolean {
  if (left === right || `${left}s` === right || `${right}s` === left) return true;
  if (left.endsWith("y") && `${left.slice(0, -1)}ies` === right) return true;
  if (right.endsWith("y") && `${right.slice(0, -1)}ies` === left) return true;
  return false;
}

function localName(qualified: string | undefined): string | undefined {
  return qualified?.slice(qualified.lastIndexOf(".") + 1);
}

function directlyNamesEntity(match: PathMatch): boolean {
  const segments = match.path.toLowerCase().split("/").filter(Boolean);
  const entityName = localName(match.entry.entityType)?.toLowerCase();
  return segments.length === 1 && entityName !== undefined && sameSingularOrPlural(segments[0], entityName);
}

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      );
    }
    previous = current;
  }

  return previous[right.length] ?? left.length;
}

function scanFor(index: GraphIndex, term: string, closestSources: ClosestSource[]): PathMatch[] {
  const queryLower = term.trim().toLowerCase();
  const queryPath = queryLower.startsWith("/") ? queryLower : `/${queryLower}`;
  const queryName = queryLower.replace(/^\/+/, "");
  const matches: PathMatch[] = [];
  const collectSources = closestSources.length === 0;
  const propertyByType = new Map<string, string>();

  for (const [typeName, type] of Object.entries(index.types)) {
    const property = Object.keys(type.properties).find((name) => name.toLowerCase() === queryName);
    if (property) propertyByType.set(typeName, property);
  }

  for (const [path, entry] of Object.entries(index.paths)) {
    const pathLower = path.toLowerCase();
    const segments = pathLower.split("/").filter(Boolean);
    if (collectSources) closestSources.push({ path, segments });
    const last = segments.at(-1) ?? "";
    const entityName = localName(entry.entityType)?.toLowerCase();
    const property = entry.entityType ? propertyByType.get(entry.entityType) : undefined;
    let score = 0;
    let matchedOn = "";

    if (pathLower === queryPath) {
      score = 1_000;
      matchedOn = "path";
    } else if (sameSingularOrPlural(queryName, last)) {
      score = 800;
      matchedOn = "path";
    } else if (entityName && sameSingularOrPlural(queryName, entityName)) {
      score = 750;
      matchedOn = `entity type ${localName(entry.entityType)}`;
    } else if (pathLower.includes(queryLower)) {
      score = segments.includes(queryName) ? 450 : 400;
      matchedOn = "path";
    } else if (property) {
      score = 300;
      matchedOn = `property ${property}`;
    } else {
      continue;
    }

    score -= segments.length * 40;
    score -= segments.filter((segment) => segment.startsWith("{") && segment.endsWith("}")).length * 25;
    if (segments.some((segment) => segment.includes("."))) score -= 80;
    if (segments.some((segment) => segment.includes("("))) score -= 60;
    if (!entry.methods.includes("get")) score -= 80;
    if (PROMINENT_ROOTS.has(segments[0] ?? "")) score += 100;

    if (score > 0) matches.push({ path, entry, score, matchedOn });
  }

  matches.sort((left, right) =>
    right.score - left.score
    || Number(directlyNamesEntity(right)) - Number(directlyNamesEntity(left))
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path));
  return matches;
}

/**
 * Words that carry no Graph meaning, dropped from a phrase before it is searched term by term.
 * `me` is among them: as a whole query it is a real path and is matched before this runs, but
 * inside a sentence it is the pronoun.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "from", "get", "has", "have", "how",
  "i", "in", "is", "it", "list", "me", "my", "of", "on", "or", "show", "tenant", "that", "the",
  "their", "them", "there", "these", "this", "to", "what", "when", "where", "which", "who", "with",
]);

export function searchIndex(index: GraphIndex, query: string, limit = 8): SearchResult {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) return { matches: [], closest: [] };

  const queryTokens = tokens(query);
  const distanceQuery = queryTokens.join("");
  const closestSources: ClosestSource[] = [];
  let matches = scanFor(index, queryLower, closestSources);

  // An agent asks in a sentence — "what properties does a user have", "how do I list the members
  // of a group" — as often as it asks with a name. Nothing in the index is named that, so when
  // the whole phrase finds nothing, search its words and keep whichever one answers best.
  if (matches.length === 0 && queryTokens.length > 1) {
    const terms = queryTokens.filter((token) => !STOP_WORDS.has(token) && token.length > 1);
    const byPath = new Map<string, { match: PathMatch; terms: number }>();
    for (const term of terms) {
      for (const match of scanFor(index, term, closestSources)) {
        const seen = byPath.get(match.path);
        if (!seen) byPath.set(match.path, { match, terms: 1 });
        else byPath.set(match.path, { match: match.score > seen.match.score ? match : seen.match, terms: seen.terms + 1 });
      }
    }
    // Answering more of the question counts for more than answering one word of it well:
    // "list the members of a group" should reach the members path, not just the group one.
    matches = [...byPath.values()]
      .map(({ match, terms: hit }) => ({ ...match, score: match.score + (hit - 1) * 150 }))
      .sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path));
  }

  if (matches.length > 0) return { matches: matches.slice(0, Math.max(0, limit)), closest: [] };

  const closestCandidates: ClosestCandidate[] = closestSources.map(({ path, segments }) => {
    const pathTokens = new Set(tokens(path));
    const overlap = new Set(queryTokens.filter((token) => pathTokens.has(token))).size;
    const distance = Math.min(...segments.map((segment) => editDistance(distanceQuery, tokens(segment).join(""))));
    return { path, overlap, distance, depth: segments.length };
  });
  closestCandidates.sort((left, right) =>
    right.overlap - left.overlap
    || left.distance - right.distance
    || left.depth - right.depth
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path));
  const closestLimit = Math.max(1, Math.min(5, Math.max(0, limit) || 5));
  return { matches: [], closest: closestCandidates.slice(0, closestLimit).map((candidate) => candidate.path) };
}
