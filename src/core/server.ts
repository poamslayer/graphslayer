import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionStore } from "./connections/store.js";
import type { GraphClient } from "./graph/client.js";
import type { MsalAuth } from "./auth/msal.js";
import type { IndexSandboxFactory, Sandbox } from "./sandbox/sandbox.js";
import { createIndexLoader } from "./index/loader.js";
import type { LoadedIndex } from "./index/loader.js";
import { registerSearchTool } from "./tools/search.js";
import { registerDocsTool, type DocsDeps } from "./tools/docs.js";
import { registerExecuteTool } from "./tools/execute.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface ServerDeps extends DocsDeps {
  store: ConnectionStore;
  client: GraphClient;
  auth: MsalAuth;
  sandbox: Pick<Sandbox, "run">;
  /** Builds the no-network sandbox an index run executes in. ADR-0008. */
  indexSandbox: IndexSandboxFactory;
  index?: () => Promise<LoadedIndex>;
}

export { SERVER_NAME, SERVER_VERSION } from "./version.js";

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const index = deps.index ?? createIndexLoader();
  registerSearchTool(server, {
    index,
    indexSandbox: deps.indexSandbox,
  });
  // MCP clients cache the tool list, so connection changes must never make a tool appear or
  // disappear during a session. A read connection still gets execute; it refuses writes itself.
  registerExecuteTool(server, deps);
  registerDocsTool(server, deps);
  // No connection tools. A person adds and removes tenants with `graphslayer connect` and
  // `graphslayer disconnect` in a terminal, so the agent can never sign in or sign out. ADR-0020.
  return server;
}
