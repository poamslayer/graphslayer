import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveCloud, type Cloud } from "../config.js";
import type { IndexLoader } from "../index/loader.js";
import type { IndexSandboxFactory, RunResult, Sandbox } from "../sandbox/sandbox.js";
import { DEFAULT_MAX_CHARS, capJson, shedToFit } from "./output.js";

/** The shape of the `index` object an index run reads. Mirrors `../index/graph-index.ts`. */
export const INDEX_TYPES = `
declare const index: {
  version: "v1.0"; builtAt: string;
  types: Record<string, {
    properties: Record<string, string>;   // property name -> CSDL type
    defaultSelect?: string[];             // what a collection read sends when you pass no select
  }>;
  enums: Record<string, { members: string[]; isFlags?: true }>;
  paths: Record<string, {
    methods: string[];            // lower case: get, post, patch, put, delete
    consistency?: true;           // needs ConsistencyLevel: eventual
    entityType?: string;          // key into types; absent when the path returns none
    scopes?: Record<string, { delegated?: Fam; application?: Fam }>;  // by method
  }>;
};
// Fam = { least?: string[]; all: string[]; alsoRequires?: Record<string, string[]> }
// An absent scopes entry means the permissions reference does not cover that call. It never
// means the call needs no consent.
`.trim();

export const SEARCH_DESCRIPTION = `Search Microsoft Graph's API catalogue: every path, method, entity property, enum, and the permissions each call needs. It runs your script over the shipped local index, with no tenant, connection, or network, so it costs nothing to call before execute. Pass cloud for a national-cloud catalogue; it defaults to commercial. On usgov-high the paths are Gov-correct but the scopes are copied from commercial and unverified (ADR-0014).

Write the body of an async function and "return" the value you want back. Output is capped at about 10,000 tokens, so filter inside the script rather than returning the index.

Available in the script:
${INDEX_TYPES}

Examples:
// Paths about conditional access, with their methods
return Object.entries(index.paths).filter(([p]) => p.toLowerCase().includes("conditionalaccess")).map(([p, e]) => ({ p, methods: e.methods }));

// Least-privileged delegated scope to list conditional access policies
return index.paths["/identity/conditionalAccess/policies"]?.scopes?.get?.delegated;

// Properties of a user, with their types
return index.types["microsoft.graph.user"]?.properties;`;

export const INDEX_TRUNCATION_NOTE =
  "Output was truncated. Count, filter, or return fewer entries inside the script.";

export interface SearchDeps {
  /** Loads the Graph index. It memoises, so the index is parsed once per process. */
  index: IndexLoader;
  /** Builds the index sandbox. Called once, lazily, on the first index run. ADR-0008. */
  indexSandbox: IndexSandboxFactory;
}

const outputSchema = {
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string(), line: z.number().optional() }).optional(),
  logs: z.array(z.string()),
  truncated: z.boolean(),
};

export interface IndexRunOutput {
  // The MCP SDK types structured content as an open record.
  [key: string]: unknown;
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string; line?: number };
  logs: string[];
  truncated: boolean;
}

/**
 * Shapes one index run into the tool result, keeping the whole payload inside the cap, the same
 * way `shapeRunOutput` does for a run. There are no call records to shed here, because an index
 * run makes no Graph calls.
 */
export function shapeIndexRunOutput(run: RunResult, maxChars: number = DEFAULT_MAX_CHARS): IndexRunOutput {
  const cappedResult = capJson(run.data, maxChars);
  const base = {
    ok: run.ok,
    result: run.ok ? (cappedResult.truncated ? cappedResult.text : run.data) : undefined,
    error: run.error
      ? { name: run.error.name, message: run.error.message, ...(run.error.line !== undefined ? { line: run.error.line } : {}) }
      : undefined,
  };

  return shedToFit<IndexRunOutput>(
    [
      { ...base, logs: run.logs, truncated: cappedResult.truncated },
      // The logged lines are the cheapest thing to lose.
      { ...base, logs: [], truncated: true },
      // Still over: the returned value alone is too big, so cut it harder and keep the shape.
      {
        ...base,
        result: run.ok ? capJson(run.data, Math.floor(maxChars / 2)).text : undefined,
        logs: [],
        truncated: true,
      },
    ],
    maxChars,
  );
}

/** The index placed as an object literal, which is the cheaper of the two placements. */
export function indexPreamble(text: string): string {
  return `const index = ${text};`;
}

/**
 * Builds an index sandbox on the first index run for a cloud and reuses it for that cloud.
 * Lazily, because the preamble needs the index source: building it eagerly would read and hold
 * the index for a server that only ever answers queries, and start a second `workerd` process
 * for one that never calls search. A failed build is not cached, so a transient failure does
 * not poison the mode for the life of the process.
 */
function lazyIndexSandbox(deps: SearchDeps): (cloud?: Cloud) => Promise<Pick<Sandbox, "run">> {
  const built = new Map<Cloud, Promise<Pick<Sandbox, "run">>>();

  return (requestedCloud) => {
    const cloud = resolveCloud(requestedCloud);
    let result = built.get(cloud);
    if (!result) {
      const attempt = deps.index(cloud).then(({ text }) => deps.indexSandbox({ preamble: indexPreamble(text) }));
      built.set(cloud, attempt);
      void attempt.catch(() => {
        if (built.get(cloud) === attempt) built.delete(cloud);
      });
      result = attempt;
    }
    return result;
  };
}

export function registerSearchTool(server: McpServer, deps: SearchDeps): void {
  const indexSandbox = lazyIndexSandbox(deps);

  server.registerTool(
    "search",
    {
      title: "Search the Microsoft Graph catalogue",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        code: z.string().describe("Body of an async JavaScript function over the index object. Return a value."),
        cloud: z.enum(["commercial", "usgov-high"]).optional()
          .describe("Microsoft cloud whose Graph catalogue to search. Defaults to commercial."),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ code, cloud }) => {
      const sandbox = await indexSandbox(cloud);
      const structured = shapeIndexRunOutput(await sandbox.run(code));
      const text = structured.truncated
        ? `${capJson(structured).text}\n\n${INDEX_TRUNCATION_NOTE}`
        : capJson(structured).text;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );
}
