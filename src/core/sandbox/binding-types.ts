/** Type declarations shown to the model in the execute tool description. Keep this short. */
export const BINDING_TYPES = `
declare const graph: {
  // One object. await graph.get("/users/{id}", { select: ["displayName"] })
  get(path: string, opts?: QueryOpts): Promise<unknown>;
  // One page. { items, nextCursor }. No page size unless you pass opts.top (max 999); Graph's own default applies. Pass opts.cursor for the next page.
  list(path: string, opts?: QueryOpts): Promise<{ items: unknown[]; nextCursor?: string }>;
  // Every page, up to max items (default 2000, hard cap 20000). Each page is one call; pass opts.top for bigger pages and fewer calls.
  all(path: string, opts?: QueryOpts & { max?: number }): Promise<unknown[]>;
  // Up to 20 requests in one $batch call. Results in order. Failed entries are { error: { status, code, message } }.
  batch(requests: Array<{ path: string; opts?: QueryOpts }>): Promise<unknown[]>;
  // Count with $count=true and ConsistencyLevel set for you.
  count(path: string, filter?: string): Promise<number>;
  // Any method. Returns { status, body }; a 204 has no body. A read-mode connection refuses all but GET.
  request(req: QueryOpts & { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: unknown }): Promise<{ status: number; body?: unknown }>;
};
interface QueryOpts {
  // Omit select on a directory collection and 4 to 10 identifying fields are sent for you.
  // Pass select: ["*"] for the whole object. search shows a path's default.
  select?: string[]; filter?: string; expand?: string[]; orderby?: string;
  search?: string; top?: number; beta?: boolean; cursor?: string;
}
// Calls may run in parallel with Promise.all. Each run may make at most 200 calls.
`.trim();
