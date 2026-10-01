import type { GraphClient, HttpMethod } from "../graph/client.js";
import { modeOf } from "../connections/store.js";
import { GraphError } from "../graph/errors.js";
import type { Connection, GraphCallRecord, QueryOpts } from "../types.js";
import type { BindingHandler } from "./sandbox.js";

export interface BindingDeps {
  client: GraphClient;
  connection: Connection;
  maxCalls?: number;
}

export const DEFAULT_MAX_CALLS = 200;

export function makeBinding(deps: BindingDeps): { handle: BindingHandler; calls: () => GraphCallRecord[] } {
  const { client, connection } = deps;
  const maxCalls = deps.maxCalls ?? DEFAULT_MAX_CALLS;
  const records: GraphCallRecord[] = [];
  let started = 0;

  async function tracked<T>(
    method: string,
    path: string,
    opts: QueryOpts | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (started >= maxCalls) throw new Error(`Graph call limit of ${maxCalls} reached for this run`);
    started += 1;
    const t0 = Date.now();
    const apiVersion = opts?.beta ? "beta" : "v1.0";
    let status = 200;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GraphError) {
        status = err.status;
        // The script sees the message and nothing else, so what the index added goes in it.
        // Left on the error object, it would never reach the reader who can act on it.
        const hint = err.hint ? `\n${err.hint}` : "";
        throw new Error(`Graph ${err.status} ${err.code}: ${err.message}${hint}`);
      }
      status = 0;
      throw err;
    } finally {
      const ms = Date.now() - t0;
      records.push({ method, path, status, ms, apiVersion });
    }
  }

  function pathArg(v: unknown): string {
    if (typeof v !== "string") throw new Error("path must be a string");
    return v;
  }

  function optsArg(v: unknown): QueryOpts | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("opts must be an object");
    return v as QueryOpts;
  }

  const handle: BindingHandler = async (op, args) => {
    switch (op) {
      case "get": {
        const path = pathArg(args[0]);
        const opts = optsArg(args[1]);
        return tracked("GET", path, opts, () => client.get(connection, path, opts));
      }
      case "list": {
        const path = pathArg(args[0]);
        const opts = optsArg(args[1]);
        return tracked("GET", path, opts, () => client.list(connection, path, opts));
      }
      case "all": {
        const path = pathArg(args[0]);
        const opts = optsArg(args[1]) as (QueryOpts & { max?: number }) | undefined;
        // Each page is a separate Graph request, so each one takes a slot from the call cap
        // and gets its own entry in calls. Counting a whole walk as one call let a script make
        // thousands of requests under a cap that said two hundred.
        return client.all(connection, path, opts, opts?.max, (fetchPage) => tracked("GET", path, opts, fetchPage));
      }
      case "batch": {
        const requests = args[0];
        if (!Array.isArray(requests)) throw new Error("batch expects an array of { path, opts }");
        return tracked("POST", "/$batch", undefined, async () => {
          const out = await client.batch(connection, requests as Array<{ path: string; opts?: QueryOpts }>);
          return out.map((r) =>
            r.status >= 200 && r.status < 300
              ? r.body
              : { error: { status: r.status, ...(((r.body as { error?: { code?: string; message?: string } })?.error) ?? {}) } },
          );
        });
      }
      case "request": {
        const { method, path, body, ...opts } = requestArg(args[0]);
        if (method !== "GET" && modeOf(connection) === "read") {
          throw new Error(`Connection "${connection.alias}" was added in read mode, so it cannot send ${method} ${path}. ${writableHint(connection)}`);
        }
        return tracked(method, path, opts, async () => {
          // DELETE sends no body: Graph has nowhere to put one.
          const res = await client.request(connection, method, path, opts, method === "DELETE" ? undefined : body);
          // A 204 answers with nothing. An empty body would claim Graph said something it did not.
          return res.body === null || res.body === undefined ? { status: res.status } : { status: res.status, body: res.body };
        });
      }
      case "count": {
        const path = pathArg(args[0]);
        const filter = args[1] === undefined ? undefined : String(args[1]);
        return tracked("GET", `${path}/$count`, filter ? { filter } : undefined, () => client.count(connection, path, filter));
      }
      default:
        throw new Error(`Unknown binding operation "${op}"`);
    }
  };

  return { handle, calls: () => records.slice() };
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

type RequestArg = QueryOpts & { method: HttpMethod; path: string; body?: unknown };

function requestArg(v: unknown): RequestArg {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("request expects { method, path, body?, ...query options }");
  const { method, path } = v as { method?: unknown; path?: unknown };
  if (typeof method !== "string" || !METHODS.has(method.toUpperCase())) throw new Error("request method must be GET, POST, PATCH, PUT or DELETE");
  if (typeof path !== "string") throw new Error("request needs a path string");
  return { ...(v as RequestArg), method: method.toUpperCase() as HttpMethod };
}

/** How a read connection is made writable, which depends on how it was added. ADR-0012. */
export function writableHint(connection: Connection): string {
  if (connection.kind === "agent") return "An agent connection that may write is added with `graphslayer connect --agent --mode write`.";
  if (connection.kind === "app") return "An app-only connection that may write is added with `graphslayer connect --app-only --mode write`.";
  return "A connection that may write is added with connection_add and the read-write template.";
}
