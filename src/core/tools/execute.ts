import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph/client.js";
import type { ConnectionStore } from "../connections/store.js";
import { BINDING_TYPES } from "../sandbox/binding-types.js";
import { makeBinding } from "../sandbox/binding.js";
import type { RunResult, Sandbox } from "../sandbox/sandbox.js";
import type { GraphCallRecord } from "../types.js";
import { DEFAULT_MAX_CHARS, capJson, shedToFit } from "./output.js";

export const EXECUTE_DESCRIPTION = `Run a JavaScript script against Microsoft Graph for one tenant. Use this for any read, filter, join, count, or change. Write the body of an async function and "return" the value you want back. Only what you return (and console.log) comes back to you, so filter and select inside the script. Output is capped at about 10,000 tokens.

Rules the server applies for you: v1.0 by default (pass beta: true per call), ConsistencyLevel and $count for advanced directory queries, Retry-After on throttling, and a path Graph cannot find answered with the closest paths the index holds. Paths are Graph-relative like "/users" or "/identity/conditionalAccess/policies", and you pass your own select. Use connections_list to find tenant aliases, and search to find a path, the properties an entity has, and the scopes a call needs, rather than guessing. graph.request writes; a connection added in read mode refuses every method but GET.

Available in the script:
${BINDING_TYPES}

Examples:
// Count enabled users
return await graph.count("/users", "accountEnabled eq true");

// Conditional access policies and their excluded users
const p = await graph.all("/identity/conditionalAccess/policies", { select: ["id","displayName","state","conditions"] });
return p.map(x => ({ id: x.id, name: x.displayName, state: x.state, excludedUsers: x.conditions?.users?.excludeUsers ?? [] }));

// Members of a group with only two fields
const page = await graph.list("/groups/{id}/members", { select: ["id","displayName"], top: 100 });
return page.items;

// Disable a user
return await graph.request({ method: "PATCH", path: "/users/{id}", body: { accountEnabled: false } });`;

export interface ExecuteDeps {
  store: Pick<ConnectionStore, "resolve">;
  client: GraphClient;
  sandbox: Pick<Sandbox, "run">;
}

const outputSchema = {
  ok: z.boolean(),
  tenant: z.string(),
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string(), line: z.number().optional() }).optional(),
  logs: z.array(z.string()),
  calls: z.array(z.object({ method: z.string(), path: z.string(), status: z.number(), ms: z.number(), apiVersion: z.string() })),
  truncated: z.boolean(),
};

export const TRUNCATION_NOTE =
  "Output was truncated. Narrow the select, add a filter, or return fewer items.";

export interface RunOutput {
  // The MCP SDK types structured content as an open record.
  [key: string]: unknown;
  ok: boolean;
  tenant: string;
  result?: unknown;
  error?: { name: string; message: string; line?: number };
  logs: string[];
  calls: GraphCallRecord[];
  truncated: boolean;
}

/**
 * Shapes one run into the tool result, keeping the whole payload inside the cap.
 * The result, the logged lines, and the call records all cost the model tokens, so
 * measuring only the result would let the other two push the payload over the cap
 * while `truncated` still said false. Shed in order of what the model can most
 * afford to lose, and report `truncated` for whatever was actually cut.
 */
export function shapeRunOutput(
  run: RunResult,
  tenant: string,
  calls: GraphCallRecord[],
  maxChars: number = DEFAULT_MAX_CHARS,
): RunOutput {
  const cappedResult = capJson(run.data, maxChars);
  const error = run.error
    ? { name: run.error.name, message: run.error.message, ...(run.error.line !== undefined ? { line: run.error.line } : {}) }
    : undefined;
  const base = {
    ok: run.ok,
    tenant,
    result: run.ok ? (cappedResult.truncated ? cappedResult.text : run.data) : undefined,
    error,
  };

  return shedToFit<RunOutput>(
    [
      { ...base, logs: run.logs, calls, truncated: cappedResult.truncated },
      // The logged lines are the cheapest thing to lose, then the per-call records.
      { ...base, logs: [], calls, truncated: true },
      { ...base, logs: [], calls: [], truncated: true },
      // Still over: the result alone is too big, so cut it harder and keep the shape.
      {
        ...base,
        result: run.ok ? capJson(run.data, Math.floor(maxChars / 2)).text : undefined,
        logs: [],
        calls: [],
        truncated: true,
      },
    ],
    maxChars,
  );
}

export function registerExecuteTool(server: McpServer, deps: ExecuteDeps): void {
  server.registerTool(
    "execute",
    {
      title: "Run a Graph script",
      description: EXECUTE_DESCRIPTION,
      inputSchema: {
        tenant: z.string().describe("Connection alias or tenant id. See connections_list."),
        code: z.string().describe("Body of an async JavaScript function. Use await graph.* and return a value."),
      },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ tenant, code }) => {
      const connection = await deps.store.resolve(tenant);
      if (!connection) {
        return {
          isError: true,
          content: [{ type: "text", text: `No connection named "${tenant}". Call connections_list to see aliases, or connection_add to sign in.` }],
        };
      }
      const { handle, calls } = makeBinding({ client: deps.client, connection });
      const run = await deps.sandbox.run(code, handle);
      const structured = shapeRunOutput(run, connection.tenantId, calls());
      const text = structured.truncated
        ? `${capJson(structured).text}\n\n${TRUNCATION_NOTE}`
        : capJson(structured).text;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );
}
