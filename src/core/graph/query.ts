import type { ApiVersion, QueryOpts } from "../types.js";

/**
 * Plan 1's rule, kept only as the fallback. The index decides now, but it can only ever say
 * "Microsoft marks this path" — it writes no marker for a path Microsoft did not mark, and that
 * silence is not a claim the header is unneeded. `/directory/administrativeUnits` carries no
 * marker and still has documented advanced-query cases that need it. So an unmarked path, and a
 * path the index holds no entry for, get answered from here rather than losing a header that
 * was working.
 *
 * `directoryRoles` was in plan 1's list and left it with #23. Microsoft's reference for
 * `GET /directoryRoles` documents `$select`, `$filter` (`eq` only) and `$expand` and nothing
 * else: no `$count`, no `$search`, no `$orderby`, no ConsistencyLevel header. The list was
 * overbroad there, and the `$count=true` that came with the header is a query option the path
 * does not take.
 */
const FALLBACK_DIRECTORY_SEGMENTS = new Set([
  "users",
  "groups",
  "devices",
  "applications",
  "servicePrincipals",
  "directoryObjects",
  "administrativeUnits",
  "contacts",
  "orgContacts",
  "roleManagement",
  "identity",
]);

/**
 * Answers whether the Graph index marks a path as needing the header. `true` or nothing, never
 * `false`, because the index records Microsoft's marker and is silent otherwise.
 */
export type ConsistencyMarker = (path: string) => true | undefined;

export function validatePath(p: string): void {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`Path must start with "/": ${p}`);
  if (p.startsWith("//")) throw new Error(`Path must not start with "//": ${p}`);
  if (/[?#\\]/.test(p)) throw new Error(`Path must not contain ? # or \\ (pass query options in opts): ${p}`);
  if (p.split("/").some((seg) => seg === "..")) throw new Error(`Path must not contain "..": ${p}`);
  if (/^[a-z]+:\/\//i.test(p)) throw new Error(`Path must be relative to Graph: ${p}`);
}

/** What a script passes as its only `select` to mean "every field Graph would return". */
export const SELECT_EVERYTHING = "*";

export function apiVersion(opts: QueryOpts | undefined): ApiVersion {
  return opts?.beta ? "beta" : "v1.0";
}

export function needsConsistency(p: string, opts: QueryOpts | undefined, marked?: ConsistencyMarker): boolean {
  if (!opts) return false;
  const advanced = Boolean(opts.filter || opts.search || opts.orderby);
  if (!advanced) return false;
  if (marked?.(p) === true) return true;
  const first = p.split("/").filter(Boolean)[0] ?? "";
  return FALLBACK_DIRECTORY_SEGMENTS.has(first);
}

/**
 * `consistency` is passed in rather than decided here, because deciding it reads the index and
 * the caller has already done that. It defaults to the answer without the index, which is the
 * fallback rule, so a caller that does not pass it is never worse off than plan 1.
 */
export function buildRequestUrl(graphOrigin: string, p: string, opts: QueryOpts = {}, consistency = needsConsistency(p, opts)): string {
  validatePath(p);
  const base = `${graphOrigin}/${apiVersion(opts)}${p}`;
  if (new URL(base).origin !== graphOrigin) throw new Error("Refusing to build a non-Graph URL");
  const params: Array<[string, string]> = [];
  // `["*"]` is how a script says "the whole object", which is sending no `$select` at all so
  // Graph answers with its own projection. It is spelled as a value rather than as the absence
  // of one because absence is what asks for the index's default.
  if (opts.select?.length && !opts.select.includes(SELECT_EVERYTHING)) {
    params.push(["$select", opts.select.join(",")]);
  }
  if (opts.filter) params.push(["$filter", opts.filter]);
  if (opts.expand?.length) params.push(["$expand", opts.expand.join(",")]);
  if (opts.orderby) params.push(["$orderby", opts.orderby]);
  if (opts.search) params.push(["$search", opts.search]);
  if (typeof opts.top === "number") params.push(["$top", String(opts.top)]);
  if (consistency) params.push(["$count", "true"]);
  if (params.length === 0) return base;
  // encodeURIComponent gives %20 for spaces. Graph does not treat "+" as a space.
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${base}?${query}`;
}

export function encodeCursor(nextLink: string): string {
  return Buffer.from(nextLink, "utf8").toString("base64url");
}

export function decodeCursor(graphOrigin: string, cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
  const link = Buffer.from(cursor, "base64url").toString("utf8");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("Invalid cursor");
  }
  if (url.origin !== graphOrigin) throw new Error("Cursor does not point at this connection's Microsoft Graph cloud");
  return link;
}
