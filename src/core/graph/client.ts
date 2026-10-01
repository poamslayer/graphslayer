import type { TokenProvider } from "../auth/token-provider.js";
import { cloudEndpoints } from "../config.js";
import { USER_AGENT } from "../version.js";
import { cloudOf } from "../connections/store.js";
import type { IndexLoader } from "../index/loader.js";
import type { IndexPaths } from "../index/paths.js";
import { createIndexPaths } from "../index/paths.js";
import type { ApiVersion, Connection, QueryOpts } from "../types.js";
import type { Page } from "../types.js";
import { GraphError } from "./errors.js";
import { apiVersion, buildRequestUrl, decodeCursor, encodeCursor, needsConsistency, validatePath } from "./query.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GraphResponse {
  status: number;
  body: unknown;
  requestId?: string;
  apiVersion: ApiVersion;
}

export interface GraphClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  maxRetryWaitSeconds?: number;
  /**
   * The shipped Graph index, which decides the consistency header and answers a path Graph
   * cannot find with the closest ones it holds. This is the loader `search` is given,
   * passed here as well so each cloud's catalogue is shared rather than loaded once per reader.
   * A load that fails is an absent index, not a failed call: the index improves a Graph call, it
   * never gates one.
   */
  index?: IndexLoader;
}

/** Wraps one page request, so a caller can count each page as its own call. */
export type PageWrapper = <T>(fetchPage: () => Promise<T>) => Promise<T>;

const RETRYABLE = new Set([429, 503, 504]);
/**
 * A write is resent only on 429, where Graph refused the request before doing anything. A 503
 * or 504 on a POST may come back after the write was applied, and resending would make it twice.
 */
const RETRYABLE_WRITE = new Set([429]);
const MAX_TOP = 999;
const MAX_BATCH = 20;
export const ALL_DEFAULT_MAX = 2000;
export const ALL_HARD_MAX = 20000;

/**
 * The page size to send, which is none unless the script asked for one.
 *
 * A default `$top` used to go on every list and every page of an `all`. Some collections refuse
 * a page size outright — `/subscribedSkus`, `/directoryRoles` and `/directoryRoleTemplates`
 * answer `400 Request_UnsupportedQuery` "This resource does not support custom page sizes" — so
 * those paths failed through `list` and `all` always, with no way for a script to opt out.
 *
 * Nothing published distinguishes those paths. Kiota declares `$top` as a query parameter on the
 * failing paths and the working ones alike, so unlike the consistency header there is no marker
 * to read and the index cannot answer this. See #31, and ADR-0010 for the rejected alternatives.
 *
 * Sending none lets Graph use its own default, which is 100 for most directory collections. That
 * costs `all` more pages than the old forced 999: walking to the 2,000-item default is about 20
 * calls rather than 3, well inside the 200-call cap a run gets. A script that wants fewer calls
 * passes `top` itself, and on a collection that accepts one it is honoured up to 999.
 */
function cappedTop(top: number | undefined): number | undefined {
  return top === undefined ? undefined : Math.min(top, MAX_TOP);
}

/**
 * The default field selection applies to a collection read and never to `get`.
 *
 * The token argument is about a hundred objects times their fields, not one object times its
 * fields: an unshaped page of a hundred users costs about ten thousand tokens and most of it is
 * fields nobody asked for. Narrowing a single-object read buys almost none of that back and is
 * the case most likely to hide a field the caller actually wanted, so `get` is left alone.
 *
 * `all` walks through `list`, so it inherits this rather than applying it again. A caller that
 * passes any `select` is never overridden, and `select: ["*"]` sends none at all. See ADR-0011.
 */
export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryWaitSeconds: number;
  private readonly indexPaths: (cloud?: Connection["cloud"]) => Promise<IndexPaths | undefined>;

  constructor(private readonly tokens: TokenProvider, opts: GraphClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryWaitSeconds = opts.maxRetryWaitSeconds ?? 30;
    this.indexPaths = opts.index ? createIndexPaths(opts.index) : async () => undefined;
  }

  /** Low level request. Callers pass a Graph-relative path such as "/users". */
  async request(
    connection: Connection,
    method: HttpMethod,
    path: string,
    opts: QueryOpts = {},
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<GraphResponse> {
    const paths = await this.indexPaths(cloudOf(connection));
    const consistency = needsConsistency(path, opts, paths?.consistency);
    const url = buildRequestUrl(cloudEndpoints(cloudOf(connection)).graphOrigin, path, opts, consistency);
    return withIndexHint(paths, path, () =>
      this.requestUrl(connection, method, url, apiVersion(opts), consistency, body, extraHeaders));
  }

  /** Request an absolute Graph URL, used for following next links. */
  async requestUrl(
    connection: Connection,
    method: HttpMethod,
    url: string,
    version: ApiVersion,
    consistency: boolean,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<GraphResponse> {
    const token = await this.tokens.getGraphToken(connection);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...extraHeaders,
      // After the caller's headers, so no caller can send a request Microsoft's logs cannot attribute.
      "user-agent": USER_AGENT,
    };
    if (consistency) headers["consistencylevel"] = "eventual";
    if (body !== undefined) headers["content-type"] = "application/json";

    let attempt = 0;
    let refreshedFor403 = false;
    for (;;) {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const requestId = res.headers.get("request-id") ?? undefined;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));

      if ((onlyReads(method, url, body) ? RETRYABLE : RETRYABLE_WRITE).has(res.status) && attempt < this.maxRetries) {
        attempt += 1;
        const wait = Math.min(retryAfter ?? 2, this.maxRetryWaitSeconds);
        await this.sleep(wait * 1000);
        continue;
      }

      // A 403 may come from a token cached before consent that was granted outside the server
      // (#73). One fresh token, one retry, and only when the fresh token gained a scope. Graph
      // refused the request, so sending it again cannot repeat a write.
      if (res.status === 403 && !refreshedFor403) {
        refreshedFor403 = true;
        const fresh = await this.freshTokenAfter403(connection);
        if (fresh) {
          headers.authorization = `Bearer ${fresh}`;
          continue;
        }
      }

      const parsed = await parseBody(res);
      if (!res.ok) {
        const errObj = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
        throw new GraphError(
          res.status,
          errObj?.code ?? `HTTP_${res.status}`,
          errObj?.message ?? res.statusText ?? "Request failed",
          requestId,
          retryAfter,
        );
      }
      return { status: res.status, body: parsed, requestId, apiVersion: version };
    }
  }

  private async freshTokenAfter403(connection: Connection): Promise<string | undefined> {
    if (connection.kind !== "delegated" || !this.tokens.refreshGraphToken) return undefined;
    return this.tokens.refreshGraphToken(connection);
  }

  async get(connection: Connection, path: string, opts: QueryOpts = {}): Promise<unknown> {
    return (await this.request(connection, "GET", path, opts)).body;
  }

  async list(connection: Connection, path: string, opts: QueryOpts = {}): Promise<Page> {
    let res: GraphResponse;
    if (opts.cursor) {
      const link = decodeCursor(cloudEndpoints(cloudOf(connection)).graphOrigin, opts.cursor);
      const paths = await this.indexPaths(cloudOf(connection));
      res = await withIndexHint(paths, path, () =>
        this.requestUrl(connection, "GET", link, apiVersion(opts), needsConsistency(path, opts, paths?.consistency)));
    } else {
      // One lookup for both questions this read asks the index: what to select, and whether the
      // path is marked for the consistency header. `request` would resolve the same memoized
      // promise again, which costs nothing but reads as though there were two sources.
      const paths = await this.indexPaths(cloudOf(connection));
      const select = opts.select?.length ? opts.select : paths?.defaultSelect(path);
      const withDefaults = { ...opts, select, top: cappedTop(opts.top) };
      const consistency = needsConsistency(path, withDefaults, paths?.consistency);
      res = await withIndexHint(paths, path, () =>
        this.requestUrl(
          connection,
          "GET",
          buildRequestUrl(cloudEndpoints(cloudOf(connection)).graphOrigin, path, withDefaults, consistency),
          apiVersion(withDefaults),
          consistency,
        ));
    }
    return pageFromBody(res.body);
  }

  async all(
    connection: Connection,
    path: string,
    opts: QueryOpts = {},
    max: number = ALL_DEFAULT_MAX,
    eachPage: PageWrapper = (fetchPage) => fetchPage(),
  ): Promise<unknown[]> {
    const limit = Math.min(max, ALL_HARD_MAX);
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await eachPage(() => this.list(connection, path, { ...opts, cursor }));
      for (const item of page.items) {
        if (items.length >= limit) return items;
        items.push(item);
      }
      cursor = page.nextCursor;
    } while (cursor && items.length < limit);
    return items;
  }

  async batch(
    connection: Connection,
    requests: Array<{ path: string; opts?: QueryOpts }>,
  ): Promise<Array<{ status: number; body: unknown }>> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_BATCH) throw new Error(`A batch may hold at most ${MAX_BATCH} requests`);
    const version = apiVersion(requests[0].opts);
    // One $batch call runs against one API version. Mixing them would silently send the
    // odd requests to the wrong version, so refuse instead of guessing.
    if (requests.some((r) => apiVersion(r.opts) !== version)) {
      throw new Error("A batch may not mix v1.0 and beta requests. Send two batches.");
    }
    const paths = await this.indexPaths(cloudOf(connection));
    const graphOrigin = cloudEndpoints(cloudOf(connection)).graphOrigin;
    const subRequestPrefix = `${graphOrigin}/v1.0`;
    const payload = {
      requests: requests.map((r, i) => {
        validatePath(r.path);
        const consistency = needsConsistency(r.path, r.opts, paths?.consistency);
        const full = buildRequestUrl(graphOrigin, r.path, { ...r.opts, beta: undefined }, consistency);
        const relative = full.slice(subRequestPrefix.length);
        const headers: Record<string, string> = {};
        if (consistency) headers["ConsistencyLevel"] = "eventual";
        return { id: String(i), method: "GET", url: relative, headers };
      }),
    };
    type BatchEntry = { id: string; status: number; body: unknown };
    const send = async (headers: Record<string, string> = {}) =>
      ((await this.request(connection, "POST", "/$batch", { beta: version === "beta" }, payload, headers)).body as { responses?: BatchEntry[] }).responses ?? [];
    let responses = await send();
    // A refused entry fails inside a 200, so requestUrl's 403 retry never sees it. Same rule (#73):
    // one fresh token, one resend, only when it gained a scope.
    if (responses.some((r) => r.status === 403)) {
      const fresh = await this.freshTokenAfter403(connection);
      if (fresh) responses = await send({ authorization: `Bearer ${fresh}` });
    }
    const byId = new Map(responses.map((r) => [r.id, r]));
    return requests.map((request, i) => {
      const r = byId.get(String(i));
      return r ? { status: r.status, body: hintedBatchBody(paths, request.path, r.status, r.body) } : { status: 0, body: null };
    });
  }

  async count(connection: Connection, path: string, filter?: string): Promise<number> {
    validatePath(path);
    const baseUrl = buildRequestUrl(cloudEndpoints(cloudOf(connection)).graphOrigin, `${path}/$count`);
    const url = filter ? `${baseUrl}?$filter=${encodeURIComponent(filter)}` : baseUrl;
    // The hint is about the collection the caller named, not the `$count` segment appended to it.
    const res = await withIndexHint(await this.indexPaths(cloudOf(connection)), path, () =>
      this.requestUrl(connection, "GET", url, "v1.0", false, undefined, {
        consistencylevel: "eventual",
        accept: "text/plain",
      }));
    const n = typeof res.body === "number" ? res.body : Number(res.body);
    if (!Number.isFinite(n)) throw new Error("Graph did not return a number for $count");
    return n;
  }
}

const DESCRIBE_POINTER = "Call search to find the path you want.";

/**
 * What the index can add to Graph's answer. Graph says only that nothing is there; the index
 * knows every path there is, so it can tell a misspelled or singular segment from an id that
 * does not exist.
 */
function hintFor(paths: IndexPaths, path: string): string {
  const template = paths.match(path);
  if (template) {
    return `"${template}" is a path the Graph index holds, so this is more likely a missing object or a wrong id than a wrong path.`;
  }
  const closest = paths.suggest(path);
  if (closest.length > 0) {
    return `The Graph index holds no path matching "${path}". Closest: ${closest.join(", ")}. ${DESCRIBE_POINTER}`;
  }
  return `The Graph index holds no path close to "${path}". ${DESCRIBE_POINTER}`;
}

/**
 * Graph reports a path it cannot resolve in two ways, and only one of them is a 404. Probed
 * against a live tenant: `/user` answers 400 `BadRequest` "Resource not found for the segment
 * 'user'", while `/me/member` and a real path carrying an id that does not exist both answer
 * 404 `Request_ResourceNotFound`. A wrong first segment is the near miss the index is best
 * placed to correct, so reading only the 404 would miss the case this is most for.
 */
const MISSING_SEGMENT = /not found for the segment/i;

function cannotFindThePath(status: number, message: string): boolean {
  return status === 404 || (status === 400 && MISSING_SEGMENT.test(message));
}

/**
 * A batch entry fails as data rather than as a thrown error, so it never reaches
 * `withIndexHint`. The hint goes onto the entry's own error object, which the binding already
 * spreads into what the script reads.
 */
function hintedBatchBody(paths: IndexPaths | undefined, path: string, status: number, body: unknown): unknown {
  if (!paths) return body;
  const error = (body as { error?: { message?: string; hint?: string } } | null)?.error;
  if (!error || error.hint !== undefined || !cannotFindThePath(status, error.message ?? "")) return body;
  return { ...(body as object), error: { ...error, hint: hintFor(paths, path) } };
}

/** Adds the index's reading of a path Graph could not find. Every other failure passes through. */
async function withIndexHint<T>(paths: IndexPaths | undefined, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!paths || !(err instanceof GraphError) || err.hint !== undefined) throw err;
    if (!cannotFindThePath(err.status, err.message)) throw err;
    throw new GraphError(err.status, err.code, err.message, err.requestId, err.retryAfterSeconds, hintFor(paths, path));
  }
}

function pageFromBody(body: unknown): Page {
  const b = (body ?? {}) as { value?: unknown[]; "@odata.nextLink"?: string };
  const items = Array.isArray(b.value) ? b.value : [];
  const next = typeof b["@odata.nextLink"] === "string" ? encodeCursor(b["@odata.nextLink"]) : undefined;
  return next ? { items, nextCursor: next } : { items };
}

/** A GET, or a $batch whose every request is a GET, changes nothing and is safe to send again. */
function onlyReads(method: HttpMethod, url: string, body: unknown): boolean {
  if (method === "GET") return true;
  const requests = (body as { requests?: Array<{ method?: string }> } | undefined)?.requests;
  return method === "POST" && new URL(url).pathname.endsWith("/$batch") && Array.isArray(requests) && requests.every((r) => (r.method ?? "GET").toUpperCase() === "GET");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) return JSON.parse(text);
  const asNumber = Number(text);
  return Number.isFinite(asNumber) && text.trim() !== "" ? asNumber : text;
}
