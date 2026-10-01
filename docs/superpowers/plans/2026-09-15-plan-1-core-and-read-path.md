# Plan 1 of 4: Core and read path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working local MCP server that signs into a Microsoft 365 tenant, stores the connection, and lets the model run a read-only script against Microsoft Graph inside a `workerd` V8 isolate driven by Miniflare.

**Architecture:** One TypeScript package. A transport-agnostic core holds connections, a guarded Graph client, an audit log, the sandbox, and the tools. A stdio entry point wires the real dependencies together. Every unit takes its dependencies as constructor arguments so tests can pass fakes. The sandbox is Cloudflare's `workerd` runtime started through Miniflare; the model's script runs in a fresh isolate whose only network path is a Node function in our process.

**Tech Stack:** Node 22, TypeScript 5, ESM, `@modelcontextprotocol/sdk` 1.30, `zod` 4, `miniflare` 4.20260730.0 (pinned exactly, brings `workerd`), `@azure/msal-node` 6 with `@azure/msal-node-extensions` 5 for the token cache, `open` 11, `vitest` 5.

**Reference:** `docs/research/cloudflare-mcp-code-mode-reference.md` records the Cloudflare server this sandbox design follows and the local spike that proved it.

**Spec:** `docs/superpowers/specs/2026-09-15-code-mode-graph-mcp-design.md`. Read it before starting.

**Plan series.** This is plan 1 of 4. Plan 2 adds the Graph index and `graph_describe`. Plan 3 adds the policy engine, `graph_write`, `policy_show`, and app-only connections. Plan 4 adds the five task tools and release packaging. Each plan produces working software on its own.

---

## Worker routing

Every task names its worker, per the routing table in the user's global CLAUDE.md.

- **Coding tasks (all tasks below):** Codex headless worker, `gpt-5.6-sol`, effort high, `-s workspace-write`, scoped to this repo. Pass the task text verbatim plus the "Shared context for every worker" section below. The worker gets no other context.
- **Review after each task:** Sonnet 5 subagent, effort medium, small-diff review against the task's acceptance steps and the spec section it implements.
- **If a Codex worker fails twice on the same task:** Opus 5 subagent, effort xhigh, with Claude Code tools.

Example worker command, run from Bash:

```bash
codex exec -m gpt-5.6-sol -c model_reasoning_effort=high -s workspace-write \
  -C /Users/arnoldd/ms-graph-mcp -o /private/tmp/claude-501/-Users-arnoldd-ms-graph-mcp/e25733af-74da-4eaa-b1f2-fa9addea21ce/scratchpad/task-N.md \
  "<shared context> <task N text verbatim>"
```

## Shared context for every worker

Paste this at the top of every worker prompt.

> You are implementing one task of a TypeScript MCP server in the repo at the working directory. Read `docs/superpowers/specs/2026-09-15-code-mode-graph-mcp-design.md` first. Work on the branch `feature/plan-1-core` (create it from `main` if it does not exist). Follow the task steps exactly and in order. Write the test first, run it and confirm it fails, then write the implementation, then run the test and confirm it passes, then commit with the given message. Use `npm test -- <file>` to run one test file. Do not add features the task does not ask for. Do not modify files the task does not list. When done, write a short report to the output file that names every file you changed and pastes the final test output.

## File structure

```
package.json
tsconfig.json
vitest.config.ts
.gitignore
README.md
src/
  core/
    config.ts                 home directory, constants, env flags
    types.ts                  shared types: Connection, QueryOpts, Page, GraphCallRecord
    connections/store.ts      read and write connections.json
    graph/query.ts            URL building, path validation, consistency detection
    graph/errors.ts           GraphError
    graph/client.ts           GraphClient: request, retry, get, list, all, batch, count
    audit/logger.ts           AuditLogger: NDJSON per day
    sandbox/binding-types.ts  the d.ts string shown in the graph_run description
    sandbox/binding.ts        makeReadBinding: the Node-side handler the sandbox calls into
    sandbox/sandbox-worker.ts the host worker source and the per-run sandbox module template
    sandbox/runner.ts         SandboxRunner: Miniflare lifecycle, deadline, dispatch to the binding
    tools/output.ts           capJson helper
    tools/graph-run.ts        registerGraphRunTool
    tools/connections.ts      registerConnectionTools
    server.ts                 createServer(deps)
    auth/token-provider.ts    TokenProvider interface
    auth/msal.ts              MsalAuth: delegated sign-in and silent tokens
  transport/stdio/main.ts     startStdioServer()
  cli/main.ts                 bin entry: no args starts the server, `connect` signs in
test/
  (mirrors src, one test file per module)
```

---

### Task 1: Scaffold the package

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/core/types.ts`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feature/plan-1-core
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "ms-graph-mcp",
  "version": "0.1.0",
  "description": "Microsoft Graph MCP server with a read-only code-mode sandbox and gated writes",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "bin": { "ms-graph-mcp": "dist/cli/main.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "node dist/cli/main.js"
  },
  "dependencies": {
    "@azure/msal-node": "^6.0.1",
    "@azure/msal-node-extensions": "^5.5.1",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "miniflare": "4.20260730.0",
    "open": "^11.0.4",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.20.3",
    "typescript": "5",
    "vitest": "^5.0.1"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 6: Write `src/core/types.ts`**

```ts
export type ConnectionKind = "delegated" | "app";

export interface Connection {
  alias: string;
  tenantId: string;
  tenantName?: string;
  kind: ConnectionKind;
  clientId: string;
  homeAccountId?: string;
  username?: string;
  scopes: string[];
  addedAt: string;
}

export type ApiVersion = "v1.0" | "beta";

export interface QueryOpts {
  select?: string[];
  filter?: string;
  expand?: string[];
  orderby?: string;
  search?: string;
  top?: number;
  beta?: boolean;
  cursor?: string;
}

export interface Page {
  items: unknown[];
  nextCursor?: string;
}

export interface GraphCallRecord {
  method: string;
  path: string;
  status: number;
  ms: number;
  apiVersion: ApiVersion;
}
```

- [ ] **Step 7: Write the smoke test `test/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { Connection } from "../src/core/types.js";

describe("scaffold", () => {
  it("compiles shared types", () => {
    const c: Connection = {
      alias: "contoso",
      tenantId: "00000000-0000-0000-0000-000000000001",
      kind: "delegated",
      clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
      scopes: ["User.Read"],
      addedAt: new Date().toISOString(),
    };
    expect(c.alias).toBe("contoso");
  });
});
```

- [ ] **Step 8: Install and run**

Run: `npm install && npm test`
Expected: 1 test passed. The install is about 170 MB because `miniflare` brings the `workerd` binary for this platform. That is expected.

Run: `npm run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/core/types.ts test/smoke.test.ts
git commit -m "Scaffold TypeScript package with vitest and shared types"
```

---

### Task 2: Config and constants

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/config.ts`
- Test: `test/core/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULT_CLIENT_ID } from "../../src/core/config.js";

describe("resolveConfig", () => {
  it("uses the home directory by default", () => {
    const cfg = resolveConfig({ HOME: "/Users/test" });
    expect(cfg.homeDir).toBe("/Users/test/.ms-graph-mcp");
    expect(cfg.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(cfg.tokenCacheEnabled).toBe(true);
  });

  it("honours env overrides", () => {
    const cfg = resolveConfig({
      HOME: "/Users/test",
      MSGRAPH_MCP_HOME: "/tmp/x",
      MSGRAPH_MCP_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
      MSGRAPH_MCP_NO_TOKEN_CACHE: "1",
    });
    expect(cfg.homeDir).toBe("/tmp/x");
    expect(cfg.clientId).toBe("11111111-1111-1111-1111-111111111111");
    expect(cfg.tokenCacheEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/config.test.ts`
Expected: FAIL, cannot find module `../../src/core/config.js`.

- [ ] **Step 3: Write `src/core/config.ts`**

```ts
import path from "node:path";

/** Microsoft Graph Command Line Tools. Listed by Microsoft Learn as a Microsoft tenant-owned application. */
export const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_SCOPE_DEFAULT = "https://graph.microsoft.com/.default";
export const LOGIN_AUTHORITY_BASE = "https://login.microsoftonline.com";

/** Scopes asked for on first delegated sign-in. Read only. */
export const DEFAULT_SIGNIN_SCOPES = [
  "User.Read",
  "User.Read.All",
  "Group.Read.All",
  "Directory.Read.All",
  "Policy.Read.All",
  "AuditLog.Read.All",
  "Device.Read.All",
  "Application.Read.All",
  "RoleManagement.Read.Directory",
  "UserAuthenticationMethod.Read.All",
];

export interface Config {
  homeDir: string;
  connectionsFile: string;
  auditDir: string;
  msalCacheFile: string;
  clientId: string;
  tokenCacheEnabled: boolean;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  const homeDir = env.MSGRAPH_MCP_HOME ?? path.join(home, ".ms-graph-mcp");
  return {
    homeDir,
    connectionsFile: path.join(homeDir, "connections.json"),
    auditDir: path.join(homeDir, "audit"),
    msalCacheFile: path.join(homeDir, "msal-cache.json"),
    clientId: env.MSGRAPH_MCP_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    tokenCacheEnabled: env.MSGRAPH_MCP_NO_TOKEN_CACHE !== "1",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/config.test.ts`
Expected: 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts test/core/config.test.ts
git commit -m "Add config resolution with home dir, client id, and cache flag"
```

---

### Task 3: Connections store

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/connections/store.ts`
- Test: `test/core/connections/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConnectionStore } from "../../../src/core/connections/store.js";
import type { Connection } from "../../../src/core/types.js";

function sample(alias: string, tenantId: string): Connection {
  return {
    alias,
    tenantId,
    kind: "delegated",
    clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
    scopes: ["User.Read"],
    addedAt: "2026-09-15T00:00:00.000Z",
  };
}

describe("ConnectionStore", () => {
  let file: string;
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(os.tmpdir(), "conn-")), "connections.json");
  });

  it("starts empty when the file does not exist", async () => {
    const store = new ConnectionStore(file);
    expect(await store.list()).toEqual([]);
  });

  it("adds, persists, and resolves by alias or tenant id", async () => {
    const store = new ConnectionStore(file);
    await store.upsert(sample("contoso", "00000000-0000-0000-0000-000000000001"));
    const again = new ConnectionStore(file);
    expect((await again.list()).map((c) => c.alias)).toEqual(["contoso"]);
    expect((await again.resolve("contoso"))?.tenantId).toBe("00000000-0000-0000-0000-000000000001");
    expect((await again.resolve("00000000-0000-0000-0000-000000000001"))?.alias).toBe("contoso");
    expect(await again.resolve("nope")).toBeUndefined();
  });

  it("upsert replaces a connection with the same alias", async () => {
    const store = new ConnectionStore(file);
    await store.upsert(sample("contoso", "00000000-0000-0000-0000-000000000001"));
    await store.upsert({ ...sample("contoso", "00000000-0000-0000-0000-000000000002") });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].tenantId).toBe("00000000-0000-0000-0000-000000000002");
  });

  it("removes by alias and reports whether anything was removed", async () => {
    const store = new ConnectionStore(file);
    await store.upsert(sample("contoso", "00000000-0000-0000-0000-000000000001"));
    expect(await store.remove("contoso")).toBe(true);
    expect(await store.remove("contoso")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/connections/store.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/connections/store.ts`**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Connection } from "../types.js";

interface FileShape {
  version: 1;
  connections: Connection[];
}

export class ConnectionStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Connection[]> {
    return (await this.read()).connections;
  }

  /** Accepts an alias or a tenant id. */
  async resolve(key: string): Promise<Connection | undefined> {
    const all = await this.list();
    return all.find((c) => c.alias === key) ?? all.find((c) => c.tenantId === key);
  }

  async upsert(connection: Connection): Promise<void> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== connection.alias);
    await this.write({ version: 1, connections: [...rest, connection] });
  }

  async remove(alias: string): Promise<boolean> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== alias);
    if (rest.length === data.connections.length) return false;
    await this.write({ version: 1, connections: rest });
    return true;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { version: 1, connections: Array.isArray(parsed.connections) ? parsed.connections : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [] };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/connections/store.test.ts`
Expected: 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/connections/store.ts test/core/connections/store.test.ts
git commit -m "Add connection store backed by a JSON file"
```

---

### Task 4: Graph query builder and path validation

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/graph/query.ts`
- Test: `test/core/graph/query.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildRequestUrl, needsConsistency, validatePath, encodeCursor, decodeCursor } from "../../../src/core/graph/query.js";

describe("validatePath", () => {
  it("accepts a normal relative path", () => {
    expect(() => validatePath("/users")).not.toThrow();
    expect(() => validatePath("/users/abc/memberOf")).not.toThrow();
  });
  it("accepts a user principal name in the path", () => {
    expect(() => validatePath("/users/admin@contoso.com")).not.toThrow();
  });
  it("rejects absolute urls, traversal, and odd characters", () => {
    expect(() => validatePath("https://evil.example/users")).toThrow();
    expect(() => validatePath("users")).toThrow();
    expect(() => validatePath("/users/../me")).toThrow();
    expect(() => validatePath("//evil.example/users")).toThrow();
    expect(() => validatePath("/users?x=1")).toThrow();
    expect(() => validatePath("/users#x")).toThrow();
  });
});

describe("buildRequestUrl", () => {
  it("builds v1.0 by default and percent-encodes odata values", () => {
    const url = buildRequestUrl("/users", { select: ["id", "displayName"], top: 5 });
    expect(url).toBe("https://graph.microsoft.com/v1.0/users?$select=id%2CdisplayName&$top=5");
  });
  it("encodes spaces as %20, not +", () => {
    const url = buildRequestUrl("/users", { filter: "accountEnabled eq true" });
    expect(url).toContain("$filter=accountEnabled%20eq%20true");
  });
  it("uses beta when asked", () => {
    expect(buildRequestUrl("/users", { beta: true })).toBe("https://graph.microsoft.com/beta/users");
  });
  it("adds $count=true when consistency is needed", () => {
    const url = buildRequestUrl("/users", { filter: "endsWith(mail,'x')" });
    expect(url).toContain("$count=true");
  });
});

describe("needsConsistency", () => {
  it("is true for advanced queries on directory objects", () => {
    expect(needsConsistency("/users", { filter: "x" })).toBe(true);
    expect(needsConsistency("/groups/1/members", { search: "x" })).toBe(true);
    expect(needsConsistency("/servicePrincipals", { orderby: "displayName" })).toBe(true);
  });
  it("is false for plain reads and for non-directory paths", () => {
    expect(needsConsistency("/users", {})).toBe(false);
    expect(needsConsistency("/me/messages", { filter: "isRead eq false" })).toBe(false);
  });
});

describe("cursor", () => {
  it("round trips a graph next link and rejects other hosts", () => {
    const link = "https://graph.microsoft.com/v1.0/users?$skiptoken=abc";
    expect(decodeCursor(encodeCursor(link))).toBe(link);
    expect(() => decodeCursor(encodeCursor("https://evil.example/x"))).toThrow();
    expect(() => decodeCursor("not-base64!")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/graph/query.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/graph/query.ts`**

```ts
import { GRAPH_ORIGIN } from "../config.js";
import type { ApiVersion, QueryOpts } from "../types.js";

/** First path segments whose advanced queries require ConsistencyLevel: eventual. */
const DIRECTORY_SEGMENTS = new Set([
  "users",
  "groups",
  "devices",
  "applications",
  "servicePrincipals",
  "directoryObjects",
  "directoryRoles",
  "administrativeUnits",
  "contacts",
  "orgContacts",
  "roleManagement",
  "identity",
]);

export function validatePath(p: string): void {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`Path must start with "/": ${p}`);
  if (p.startsWith("//")) throw new Error(`Path must not start with "//": ${p}`);
  if (/[?#\\]/.test(p)) throw new Error(`Path must not contain ? # or \\ (pass query options in opts): ${p}`);
  if (p.split("/").some((seg) => seg === "..")) throw new Error(`Path must not contain "..": ${p}`);
  if (/^[a-z]+:\/\//i.test(p)) throw new Error(`Path must be relative to Graph: ${p}`);
}

export function apiVersion(opts: QueryOpts | undefined): ApiVersion {
  return opts?.beta ? "beta" : "v1.0";
}

export function needsConsistency(p: string, opts: QueryOpts | undefined): boolean {
  if (!opts) return false;
  const advanced = Boolean(opts.filter || opts.search || opts.orderby);
  if (!advanced) return false;
  const first = p.split("/").filter(Boolean)[0] ?? "";
  return DIRECTORY_SEGMENTS.has(first);
}

export function buildRequestUrl(p: string, opts: QueryOpts = {}): string {
  validatePath(p);
  const base = `${GRAPH_ORIGIN}/${apiVersion(opts)}${p}`;
  if (new URL(base).origin !== GRAPH_ORIGIN) throw new Error("Refusing to build a non-Graph URL");
  const params: Array<[string, string]> = [];
  if (opts.select?.length) params.push(["$select", opts.select.join(",")]);
  if (opts.filter) params.push(["$filter", opts.filter]);
  if (opts.expand?.length) params.push(["$expand", opts.expand.join(",")]);
  if (opts.orderby) params.push(["$orderby", opts.orderby]);
  if (opts.search) params.push(["$search", opts.search]);
  if (typeof opts.top === "number") params.push(["$top", String(opts.top)]);
  if (needsConsistency(p, opts)) params.push(["$count", "true"]);
  if (params.length === 0) return base;
  // encodeURIComponent gives %20 for spaces. Graph does not treat "+" as a space.
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${base}?${query}`;
}

export function encodeCursor(nextLink: string): string {
  return Buffer.from(nextLink, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
  const link = Buffer.from(cursor, "base64url").toString("utf8");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("Invalid cursor");
  }
  if (url.origin !== GRAPH_ORIGIN) throw new Error("Cursor does not point at Microsoft Graph");
  return link;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/graph/query.test.ts`
Expected: 10 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/query.ts test/core/graph/query.test.ts
git commit -m "Add Graph URL builder with path validation and consistency detection"
```

---

### Task 5: Graph client with retry and errors

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/graph/errors.ts`
- Create: `src/core/graph/client.ts`
- Create: `src/core/auth/token-provider.ts`
- Test: `test/core/graph/client.test.ts`

- [ ] **Step 1: Write `src/core/auth/token-provider.ts`**

```ts
import type { Connection } from "../types.js";

export interface TokenProvider {
  /** Returns a bearer token for Microsoft Graph for this connection. */
  getGraphToken(connection: Connection): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "../../../src/core/graph/client.js";
import { GraphError } from "../../../src/core/graph/errors.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

const tokens = { getGraphToken: async () => "tok" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GraphClient.request", () => {
  it("sends bearer token, compact accept header, and returns json", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users/abc?$select=id");
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
      return jsonResponse(200, { id: "abc" }, { "request-id": "r1" });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    const res = await client.request(conn, "GET", "/users/abc", { select: ["id"] });
    expect(res.body).toEqual({ id: "abc" });
    expect(res.status).toBe(200);
    expect(res.requestId).toBe("r1");
    expect(res.apiVersion).toBe("v1.0");
  });

  it("sets ConsistencyLevel eventual for advanced directory queries", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return jsonResponse(200, { value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    await client.request(conn, "GET", "/users", { filter: "startsWith(displayName,'a')" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 using Retry-After and then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return jsonResponse(429, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "3" });
      return jsonResponse(200, { ok: true });
    });
    const client = new GraphClient(tokens, { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const res = await client.request(conn, "GET", "/users");
    expect(res.body).toEqual({ ok: true });
    expect(waits).toEqual([3000]);
  });

  it("gives up after the retry budget and throws a GraphError with status 429", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { code: "TooManyRequests", message: "slow down" } }, { "retry-after": "1" }));
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {}, maxRetries: 2 });
    await expect(client.request(conn, "GET", "/users")).rejects.toMatchObject({ status: 429, code: "TooManyRequests" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws GraphError with code, message, and request id on 403", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }, { "request-id": "r9" }),
    );
    const client = new GraphClient(tokens, { fetchImpl, sleep: async () => {} });
    const err = await client.request(conn, "GET", "/users").catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("Authorization_RequestDenied");
    expect(err.requestId).toBe("r9");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/core/graph/client.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write `src/core/graph/errors.ts`**

```ts
export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GraphError";
  }

  toJSON() {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}
```

- [ ] **Step 5: Write `src/core/graph/client.ts`**

```ts
import type { TokenProvider } from "../auth/token-provider.js";
import type { ApiVersion, Connection, QueryOpts } from "../types.js";
import { GraphError } from "./errors.js";
import { apiVersion, buildRequestUrl, needsConsistency } from "./query.js";

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
}

const RETRYABLE = new Set([429, 503, 504]);

export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryWaitSeconds: number;

  constructor(private readonly tokens: TokenProvider, opts: GraphClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryWaitSeconds = opts.maxRetryWaitSeconds ?? 30;
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
    const url = buildRequestUrl(path, opts);
    return this.requestUrl(connection, method, url, apiVersion(opts), needsConsistency(path, opts), body, extraHeaders);
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
    };
    if (consistency) headers["consistencylevel"] = "eventual";
    if (body !== undefined) headers["content-type"] = "application/json";

    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const requestId = res.headers.get("request-id") ?? undefined;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        attempt += 1;
        const wait = Math.min(retryAfter ?? 2, this.maxRetryWaitSeconds);
        await this.sleep(wait * 1000);
        continue;
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- test/core/graph/client.test.ts`
Expected: 5 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/core/auth/token-provider.ts src/core/graph/errors.ts src/core/graph/client.ts test/core/graph/client.test.ts
git commit -m "Add guarded Graph client with retry-after handling and typed errors"
```

---

### Task 6: Graph client paging, all, batch, and count

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Modify: `src/core/graph/client.ts` (append methods to `GraphClient`)
- Test: `test/core/graph/client-paging.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "../../../src/core/graph/client.js";
import { encodeCursor } from "../../../src/core/graph/query.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};
const tokens = { getGraphToken: async () => "tok" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GraphClient.list", () => {
  it("returns items and an opaque cursor, and defaults $top to 50", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("$top=50");
      return json({ value: [{ id: "1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=zz" });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const page = await client.list(conn, "/users");
    expect(page.items).toEqual([{ id: "1" }]);
    expect(page.nextCursor).toBe(encodeCursor("https://graph.microsoft.com/v1.0/users?$skiptoken=zz"));
  });

  it("follows a cursor instead of building a url", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users?$skiptoken=zz");
      return json({ value: [{ id: "2" }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const page = await client.list(conn, "/users", { cursor: encodeCursor("https://graph.microsoft.com/v1.0/users?$skiptoken=zz") });
    expect(page.items).toEqual([{ id: "2" }]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("caps $top at 999", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("$top=999");
      return json({ value: [] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    await client.list(conn, "/users", { top: 5000 });
  });
});

describe("GraphClient.all", () => {
  it("walks pages until done or until max is reached", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 3) return json({ value: [{ n }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/users?$skiptoken=${n}` });
      return json({ value: [{ n }] });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/users", {}, 10);
    expect(items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops at max", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ value: [{ a: 1 }, { a: 2 }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=1" }),
    );
    const client = new GraphClient(tokens, { fetchImpl });
    const items = await client.all(conn, "/users", {}, 3);
    expect(items).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GraphClient.batch", () => {
  it("posts to $batch and returns bodies in request order", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/$batch");
      const sent = JSON.parse(String(init.body)) as { requests: Array<{ id: string; url: string; method: string }> };
      expect(sent.requests.map((r) => r.url)).toEqual(["/users/a?$select=id", "/users/b"]);
      return json({
        responses: [
          { id: "1", status: 404, body: { error: { code: "NotFound", message: "no" } } },
          { id: "0", status: 200, body: { id: "a" } },
        ],
      });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    const out = await client.batch(conn, [
      { path: "/users/a", opts: { select: ["id"] } },
      { path: "/users/b" },
    ]);
    expect(out).toEqual([
      { status: 200, body: { id: "a" } },
      { status: 404, body: { error: { code: "NotFound", message: "no" } } },
    ]);
  });

  it("rejects more than 20 requests", async () => {
    const client = new GraphClient(tokens, { fetchImpl: vi.fn() });
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `/users/${i}` }));
    await expect(client.batch(conn, many)).rejects.toThrow(/20/);
  });
});

describe("GraphClient.count", () => {
  it("calls $count with the consistency header and returns a number", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/users/$count?$filter=accountEnabled%20eq%20true");
      expect((init.headers as Record<string, string>)["consistencylevel"]).toBe("eventual");
      return new Response("42", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const client = new GraphClient(tokens, { fetchImpl });
    expect(await client.count(conn, "/users", "accountEnabled eq true")).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/graph/client-paging.test.ts`
Expected: FAIL, `client.list is not a function`.

- [ ] **Step 3: Add the methods to `GraphClient` in `src/core/graph/client.ts`**

Add these imports at the top of the file, replacing the existing import from `./query.js`:

```ts
import { apiVersion, buildRequestUrl, decodeCursor, encodeCursor, needsConsistency, validatePath } from "./query.js";
import type { Page } from "../types.js";
```

Add these constants after `RETRYABLE`:

```ts
const DEFAULT_TOP = 50;
const MAX_TOP = 999;
const MAX_BATCH = 20;
export const ALL_DEFAULT_MAX = 2000;
export const ALL_HARD_MAX = 20000;
```

Add these methods inside the `GraphClient` class, after `requestUrl`:

```ts
  async get(connection: Connection, path: string, opts: QueryOpts = {}): Promise<unknown> {
    return (await this.request(connection, "GET", path, opts)).body;
  }

  async list(connection: Connection, path: string, opts: QueryOpts = {}): Promise<Page> {
    let res: GraphResponse;
    if (opts.cursor) {
      const link = decodeCursor(opts.cursor);
      res = await this.requestUrl(connection, "GET", link, apiVersion(opts), needsConsistency(path, opts));
    } else {
      const top = Math.min(opts.top ?? DEFAULT_TOP, MAX_TOP);
      res = await this.request(connection, "GET", path, { ...opts, top });
    }
    return pageFromBody(res.body);
  }

  async all(connection: Connection, path: string, opts: QueryOpts = {}, max: number = ALL_DEFAULT_MAX): Promise<unknown[]> {
    const limit = Math.min(max, ALL_HARD_MAX);
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(connection, path, { ...opts, top: MAX_TOP, cursor });
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
    const payload = {
      requests: requests.map((r, i) => {
        validatePath(r.path);
        const full = buildRequestUrl(r.path, { ...r.opts, beta: undefined });
        const relative = full.slice(`https://graph.microsoft.com/v1.0`.length);
        const headers: Record<string, string> = {};
        if (needsConsistency(r.path, r.opts)) headers["ConsistencyLevel"] = "eventual";
        return { id: String(i), method: "GET", url: relative, headers };
      }),
    };
    const res = await this.request(connection, "POST", "/$batch", { beta: version === "beta" }, payload);
    const responses = ((res.body as { responses?: Array<{ id: string; status: number; body: unknown }> }).responses ?? []);
    const byId = new Map(responses.map((r) => [r.id, r]));
    return requests.map((_, i) => {
      const r = byId.get(String(i));
      return r ? { status: r.status, body: r.body } : { status: 0, body: null };
    });
  }

  async count(connection: Connection, path: string, filter?: string): Promise<number> {
    validatePath(path);
    const opts: QueryOpts = filter ? { filter } : {};
    const res = await this.request(connection, "GET", `${path}/$count`, opts, undefined, { consistencylevel: "eventual" });
    const n = typeof res.body === "number" ? res.body : Number(res.body);
    if (!Number.isFinite(n)) throw new Error("Graph did not return a number for $count");
    return n;
  }
```

Add this helper at the bottom of the file:

```ts
function pageFromBody(body: unknown): Page {
  const b = (body ?? {}) as { value?: unknown[]; "@odata.nextLink"?: string };
  const items = Array.isArray(b.value) ? b.value : [];
  const next = typeof b["@odata.nextLink"] === "string" ? encodeCursor(b["@odata.nextLink"]) : undefined;
  return next ? { items, nextCursor: next } : { items };
}
```

Note for the batch method: `buildRequestUrl` always adds `$count=true` when consistency is needed, and the relative URL keeps it. The `$count` path in `count()` passes the consistency header directly because `needsConsistency` only looks at query options.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/graph/client-paging.test.ts`
Expected: 8 tests passed.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/client.ts test/core/graph/client-paging.test.ts
git commit -m "Add paging, all, batch, and count to the Graph client"
```

---

### Task 7: Audit logger

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/audit/logger.ts`
- Test: `test/core/audit/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLogger } from "../../../src/core/audit/logger.js";

describe("AuditLogger", () => {
  it("appends one json line per event to a dated file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "audit-"));
    const now = () => new Date("2026-09-15T12:00:00.000Z");
    const log = new AuditLogger(dir, now);
    await log.write({ tenant: "t1", principal: "user@x", tool: "graph_run", method: "GET", path: "/users", status: 200, ms: 12 });
    await log.write({ tenant: "t1", principal: "user@x", tool: "graph_run", method: "GET", path: "/groups", status: 403, ms: 5 });
    const files = readdirSync(dir);
    expect(files).toEqual(["2026-09-15.ndjson"]);
    const lines = readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.ts).toBe("2026-09-15T12:00:00.000Z");
    expect(first.path).toBe("/users");
  });

  it("hashes bodies instead of storing them", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "audit-"));
    const log = new AuditLogger(dir);
    await log.write({ tenant: "t1", principal: "p", tool: "graph_write", method: "PATCH", path: "/users/1", status: 204, ms: 1, body: { displayName: "secret" } });
    const line = readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
    expect(line).not.toContain("secret");
    expect(JSON.parse(line).bodyHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/audit/logger.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/audit/logger.ts`**

```ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface AuditEvent {
  tenant: string;
  principal: string;
  tool: string;
  method?: string;
  path?: string;
  query?: string;
  status?: number;
  ms?: number;
  body?: unknown;
  scriptHash?: string;
  note?: string;
}

export class AuditLogger {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  async write(event: AuditEvent): Promise<void> {
    const ts = this.now();
    const { body, ...rest } = event;
    const line = {
      ts: ts.toISOString(),
      ...rest,
      ...(body !== undefined ? { bodyHash: sha256(JSON.stringify(body)) } : {}),
    };
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${ts.toISOString().slice(0, 10)}.ndjson`);
    await fs.appendFile(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/audit/logger.test.ts`
Expected: 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/audit/logger.ts test/core/audit/logger.test.ts
git commit -m "Add newline-delimited JSON audit logger"
```

---

### Task 8: Sandbox runner on workerd via Miniflare

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/sandbox/sandbox-worker.ts`
- Create: `src/core/sandbox/runner.ts`
- Test: `test/core/sandbox/runner.test.ts`

How it works. Miniflare starts `workerd` with one host worker. The host worker has a Worker Loader binding named `LOADER` and a service binding named `GRAPH`. `GRAPH` is a plain Node function in our process. For each run the host worker asks the loader for a fresh isolate, places the model's code into the isolate's module source, and sets the isolate's `globalOutbound` to `GRAPH`, so every `fetch` the script makes goes to our Node function and nowhere else. The sandbox module defines a `graph` object whose methods `fetch` a fake host, `graph.local`, with a run id header. The Node function looks up the handler registered for that run id and calls it. Local `workerd` has no CPU limit, so the Node side aborts the request at the deadline, disposes the Miniflare instance, and lazily creates a new one on the next run. This design was proven in a spike recorded in `docs/research/cloudflare-mcp-code-mode-reference.md`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll } from "vitest";
import { SandboxRunner } from "../../../src/core/sandbox/runner.js";

const runner = new SandboxRunner({ timeoutMs: 5_000 });
afterAll(() => runner.dispose());

const noBinding = async () => {
  throw new Error("no binding in this test");
};

describe("SandboxRunner.run", () => {
  it("returns the value the script returns", async () => {
    const r = await runner.run("return 1 + 1;", noBinding);
    expect(r).toMatchObject({ ok: true, data: 2, logs: [] });
  });

  it("routes graph.* calls to the handler and returns its value", async () => {
    const seen: unknown[] = [];
    const handler = async (op: string, args: unknown[]) => {
      seen.push([op, ...args]);
      return { path: args[0] };
    };
    const r = await runner.run("const u = await graph.get('/users/1', { select: ['id'] }); return u.path;", handler);
    expect(r.ok).toBe(true);
    expect(r.data).toBe("/users/1");
    expect(seen).toEqual([["get", "/users/1", { select: ["id"] }]]);
  });

  it("passes undefined for a missing optional argument", async () => {
    const seen: unknown[][] = [];
    const handler = async (_op: string, args: unknown[]) => {
      seen.push(args);
      return 1;
    };
    await runner.run("return graph.count('/users');", handler);
    expect(seen).toEqual([["/users", undefined]]);
  });

  it("allows several binding calls in flight at once", async () => {
    let inFlight = 0;
    let max = 0;
    const handler = async (_op: string, args: unknown[]) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return args[0];
    };
    const r = await runner.run("return Promise.all([graph.get('/a'), graph.get('/b'), graph.get('/c')]);", handler);
    expect(r.data).toEqual(["/a", "/b", "/c"]);
    expect(max).toBeGreaterThan(1);
  });

  it("surfaces handler errors as script errors the script can catch", async () => {
    const handler = async () => {
      throw new Error("Graph 403 Authorization_RequestDenied: no");
    };
    const r = await runner.run("try { await graph.get('/x'); return 'no'; } catch (e) { return e.message; }", handler);
    expect(r.data).toBe("Graph 403 Authorization_RequestDenied: no");
  });

  it("captures console output", async () => {
    const r = await runner.run("console.log('hello', 2); console.error('bad'); return null;", noBinding);
    expect(r.logs).toEqual(["hello 2", "bad"]);
  });

  it("caps console output", async () => {
    const small = new SandboxRunner({ timeoutMs: 5_000, maxLogLines: 3 });
    try {
      const r = await small.run("for (let i = 0; i < 10; i++) console.log(i); return null;", noBinding);
      expect(r.logs).toEqual(["0", "1", "2"]);
    } finally {
      await small.dispose();
    }
  });

  it("reports script errors with a message", async () => {
    const r = await runner.run("throw new Error('boom');", noBinding);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("boom");
  });

  it("reports syntax errors", async () => {
    const r = await runner.run("return (;", noBinding);
    expect(r.ok).toBe(false);
    expect(`${r.error?.name} ${r.error?.message}`).toMatch(/SyntaxError|Unexpected/);
  });

  it("has no process, require, or filesystem", async () => {
    const r = await runner.run("return { process: typeof process, require: typeof require };", noBinding);
    expect(r.data).toEqual({ process: "undefined", require: "undefined" });
    const fs = await runner.run("const m = await import('node:fs'); return typeof m.readFileSync;", noBinding);
    expect(fs.ok).toBe(false);
  });

  it("cannot reach any host other than the binding", async () => {
    const r = await runner.run("const res = await fetch('https://example.com'); return { status: res.status };", noBinding);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ status: 403 });
  });

  it("stops a runaway script at the deadline and recovers for the next run", async () => {
    const short = new SandboxRunner({ timeoutMs: 1_000 });
    try {
      const r = await short.run("while (true) {}", noBinding);
      expect(r.ok).toBe(false);
      expect(r.error?.name).toBe("TimeoutError");
      const again = await short.run("return 42;", noBinding);
      expect(again.data).toBe(42);
    } finally {
      await short.dispose();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/sandbox/runner.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/sandbox/sandbox-worker.ts`**

This file holds two JavaScript sources as strings. The host worker runs inside `workerd`. It builds the per-run sandbox module by joining lines, so the model's code is inserted as data and never parsed as part of a template.

```ts
/**
 * Source of the host worker that runs inside workerd. It receives { code, runId, maxLogLines, maxLogChars },
 * creates a fresh isolate through the Worker Loader, and returns the isolate's result as JSON.
 * Written without template literals so nothing in it is interpolated by TypeScript.
 */
export const HOST_WORKER_SOURCE = [
  "export default {",
  "  async fetch(request, env) {",
  "    const { code, runId, maxLogLines, maxLogChars } = await request.json();",
  "    let out;",
  "    try {",
  '      const worker = env.LOADER.get("run-" + runId, () => ({',
  '        compatibilityDate: "2026-01-12",',
  "        globalOutbound: env.GRAPH,",
  '        mainModule: "sandbox.js",',
  '        modules: { "sandbox.js": sandboxModule(code, runId, maxLogLines, maxLogChars) },',
  "      }));",
  "      out = await worker.getEntrypoint().evaluate();",
  "    } catch (e) {",
  '      out = { ok: false, error: { name: (e && e.name) || "Error", message: (e && e.message) || String(e) }, logs: [] };',
  "    }",
  '    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });',
  "  },",
  "};",
  "",
  "function sandboxModule(code, runId, maxLogLines, maxLogChars) {",
  "  return [",
  "    'import { WorkerEntrypoint } from \"cloudflare:workers\";',",
  "    'const __runId = ' + JSON.stringify(String(runId)) + ';',",
  "    'const __maxLines = ' + Number(maxLogLines) + ';',",
  "    'const __maxChars = ' + Number(maxLogChars) + ';',",
  "    'const __logs = [];',",
  "    'let __logChars = 0;',",
  "    'function __fmt(args) { return args.map(function (a) { if (typeof a === \"string\") return a; try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); } }).join(\" \"); }',",
  "    'function __log() {',",
  "    '  const args = Array.prototype.slice.call(arguments);',",
  "    '  if (__logs.length >= __maxLines) return;',",
  "    '  const line = __fmt(args);',",
  "    '  if (__logChars + line.length > __maxChars) { __logs.push(\"[log output truncated]\"); __logChars = __maxChars; return; }',",
  "    '  __logs.push(line); __logChars += line.length;',",
  "    '}',",
  "    'const console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };',",
  "    'async function __call(op, args) {',",
  "    '  const r = await fetch(\"https://graph.local/\" + op, { method: \"POST\", headers: { \"content-type\": \"application/json\", \"x-run-id\": __runId }, body: JSON.stringify({ op: op, args: args }) });',",
  "    '  const body = await r.json();',",
  "    '  if (!body.ok) throw new Error(body.message);',",
  "    '  return body.value;',",
  "    '}',",
  "    'const graph = {',",
  "    '  get: function (path, opts) { return __call(\"get\", [path, opts]); },',",
  "    '  list: function (path, opts) { return __call(\"list\", [path, opts]); },',",
  "    '  all: function (path, opts) { return __call(\"all\", [path, opts]); },',",
  "    '  batch: function (requests) { return __call(\"batch\", [requests]); },',",
  "    '  count: function (path, filter) { return __call(\"count\", [path, filter]); },',",
  "    '};',",
  "    'export default class Run extends WorkerEntrypoint {',",
  "    '  async evaluate() {',",
  "    '    try {',",
  "    '      const __main = async () => {',",
  "    code,",
  "    '      };',",
  "    '      const data = await __main();',",
  "    '      return { ok: true, data: data === undefined ? null : data, logs: __logs };',",
  "    '    } catch (e) {',",
  "    '      return { ok: false, error: { name: (e && e.name) || \"Error\", message: (e && e.message) || String(e), stack: e && e.stack }, logs: __logs };',",
  "    '    }',",
  "    '  }',",
  "    '}',",
  "  ].join(\"\\n\");",
  "}",
].join("\n");
```

- [ ] **Step 4: Write `src/core/sandbox/runner.ts`**

```ts
import { Miniflare, NoOpLog, Response as MfResponse, type Request as MfRequest } from "miniflare";
import { HOST_WORKER_SOURCE } from "./sandbox-worker.js";

export interface RunLimits {
  timeoutMs?: number;
  maxLogLines?: number;
  maxLogChars?: number;
}

export interface RunResult {
  ok: boolean;
  data?: unknown;
  error?: { name: string; message: string; stack?: string };
  logs: string[];
}

/** Called by the sandbox for every graph.* call. `op` is get, list, all, batch, or count. */
export type BindingHandler = (op: string, args: unknown[]) => Promise<unknown>;

export const DEFAULT_LIMITS: Required<RunLimits> = {
  timeoutMs: 60_000,
  maxLogLines: 200,
  maxLogChars: 20_000,
};

const BINDING_HOST = "graph.local";

export class SandboxRunner {
  private mf: Miniflare | undefined;
  private readonly handlers = new Map<string, BindingHandler>();
  private readonly limits: Required<RunLimits>;

  constructor(limits: RunLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Starts workerd on first use. Nothing is spawned until the first run. */
  private instance(): Miniflare {
    this.mf ??= new Miniflare({
      modules: true,
      compatibilityDate: "2026-01-12",
      script: HOST_WORKER_SOURCE,
      workerLoaders: { LOADER: {} },
      serviceBindings: { GRAPH: (request) => this.dispatch(request) },
      log: new NoOpLog(),
    });
    return this.mf;
  }

  /** Every fetch from every isolate lands here. Only graph.local with a known run id is served. */
  private async dispatch(request: MfRequest): Promise<MfResponse> {
    const url = new URL(request.url);
    const handler = this.handlers.get(request.headers.get("x-run-id") ?? "");
    if (url.hostname !== BINDING_HOST || !handler) {
      return new MfResponse(`Forbidden: ${url.hostname}`, { status: 403 });
    }
    const { op, args } = (await request.json()) as { op: string; args: unknown[] };
    try {
      // JSON turns a missing argument into null. Give the handler undefined instead.
      const value = await handler(op, (args ?? []).map((a) => (a === null ? undefined : a)));
      return json({ ok: true, value: value === undefined ? null : value });
    } catch (err) {
      return json({ ok: false, message: (err as Error).message });
    }
  }

  async run(code: string, handler: BindingHandler): Promise<RunResult> {
    const runId = crypto.randomUUID();
    this.handlers.set(runId, handler);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.limits.timeoutMs);
    try {
      const res = await this.instance().dispatchFetch("http://sandbox.local/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, runId, maxLogLines: this.limits.maxLogLines, maxLogChars: this.limits.maxLogChars }),
        signal: ac.signal,
      });
      return (await res.json()) as RunResult;
    } catch (err) {
      if (ac.signal.aborted) {
        // Local workerd has no CPU limit. A runaway script wedges it, so throw the runtime away.
        await this.reset();
        return {
          ok: false,
          error: { name: "TimeoutError", message: `Script exceeded ${this.limits.timeoutMs} ms and was stopped. Fetch fewer items or narrow the query.` },
          logs: [],
        };
      }
      return { ok: false, error: { name: "SandboxError", message: (err as Error).message }, logs: [] };
    } finally {
      clearTimeout(timer);
      this.handlers.delete(runId);
    }
  }

  /** Throws the runtime away. The next run starts a fresh one in about thirty milliseconds. */
  async reset(): Promise<void> {
    const mf = this.mf;
    this.mf = undefined;
    await mf?.dispose();
  }

  async dispose(): Promise<void> {
    await this.reset();
  }
}

function json(body: unknown): MfResponse {
  return new MfResponse(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/core/sandbox/runner.test.ts`
Expected: 12 tests passed. The first test takes up to a few seconds while `workerd` starts.

If Miniflare reports that `signal` is not accepted by `dispatchFetch`, wrap the call in `Promise.race` with a timer promise that rejects, and treat that rejection exactly like the abort branch.

If the syntax error test reports `ok: true`, the host worker's `try` did not catch the module load error. Check that `env.LOADER.get(...)` is inside the `try` block, as written above.

- [ ] **Step 6: Commit**

```bash
git add src/core/sandbox/sandbox-worker.ts src/core/sandbox/runner.ts test/core/sandbox/runner.test.ts
git commit -m "Add workerd sandbox runner via Miniflare with deadline and restart"
```

---

### Task 9: Read binding

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/sandbox/binding.ts`
- Create: `src/core/sandbox/binding-types.ts`
- Test: `test/core/sandbox/binding.test.ts`

The binding is the Node-side handler the sandbox calls for every `graph.*` call. It maps an operation name to the Graph client, enforces the call cap, records each call, and writes each one to the audit log. Calls may run in parallel.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterAll } from "vitest";
import { makeReadBinding } from "../../../src/core/sandbox/binding.js";
import { SandboxRunner } from "../../../src/core/sandbox/runner.js";
import { GraphError } from "../../../src/core/graph/errors.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

function fakeClient() {
  return {
    get: vi.fn(async (_c: Connection, path: string) => ({ id: path })),
    list: vi.fn(async (_c: Connection, path: string) => ({ items: [{ id: `${path}-1` }], nextCursor: undefined })),
    all: vi.fn(async (_c: Connection, path: string) => [{ id: `${path}-a` }, { id: `${path}-b` }]),
    batch: vi.fn(async (_c: Connection, reqs: Array<{ path: string }>) => reqs.map((r) => ({ status: 200, body: { id: r.path } }))),
    count: vi.fn(async () => 7),
  };
}

const noAudit = { write: async () => {} };

describe("makeReadBinding", () => {
  it("dispatches get, list, all, batch, count and records each call", async () => {
    const client = fakeClient();
    const audit = { write: vi.fn(async () => {}) };
    const { handle, calls } = makeReadBinding({ client: client as never, connection: conn, audit, tool: "graph_run" });
    expect(await handle("get", ["/users/1"])).toEqual({ id: "/users/1" });
    expect(((await handle("list", ["/users"])) as { items: unknown[] }).items).toHaveLength(1);
    expect(await handle("all", ["/groups"])).toHaveLength(2);
    expect(await handle("batch", [[{ path: "/a" }, { path: "/b" }]])).toEqual([{ id: "/a" }, { id: "/b" }]);
    expect(await handle("count", ["/users", "x"])).toBe(7);
    expect(calls().map((c) => c.path)).toEqual(["/users/1", "/users", "/groups", "/$batch", "/users/$count"]);
    expect(audit.write).toHaveBeenCalledTimes(5);
    expect(audit.write.mock.calls[0][0]).toMatchObject({ tenant: conn.tenantId, principal: "admin@contoso.com", path: "/users/1", status: 200 });
  });

  it("passes max through to all()", async () => {
    const client = fakeClient();
    const { handle } = makeReadBinding({ client: client as never, connection: conn, audit: noAudit, tool: "graph_run" });
    await handle("all", ["/users", { select: ["id"], max: 5 }]);
    expect(client.all).toHaveBeenCalledWith(conn, "/users", { select: ["id"], max: 5 }, 5);
  });

  it("returns error objects from batch entries that failed", async () => {
    const client = fakeClient();
    client.batch.mockResolvedValueOnce([{ status: 404, body: { error: { code: "NotFound", message: "no" } } }]);
    const { handle } = makeReadBinding({ client: client as never, connection: conn, audit: noAudit, tool: "graph_run" });
    expect(await handle("batch", [[{ path: "/x" }]])).toEqual([{ error: { status: 404, code: "NotFound", message: "no" } }]);
  });

  it("turns a GraphError into a plain error the script can catch, and records the status", async () => {
    const client = fakeClient();
    client.get.mockRejectedValueOnce(new GraphError(403, "Authorization_RequestDenied", "Insufficient privileges", "r1"));
    const { handle, calls } = makeReadBinding({ client: client as never, connection: conn, audit: noAudit, tool: "graph_run" });
    await expect(handle("get", ["/users"])).rejects.toThrow(/Graph 403 Authorization_RequestDenied/);
    expect(calls()[0].status).toBe(403);
  });

  it("rejects unknown operations and bad arguments", async () => {
    const { handle } = makeReadBinding({ client: fakeClient() as never, connection: conn, audit: noAudit, tool: "graph_run" });
    await expect(handle("delete", ["/users/1"])).rejects.toThrow(/Unknown binding operation/);
    await expect(handle("get", [42])).rejects.toThrow(/path must be a string/);
  });

  it("stops after the call cap", async () => {
    const { handle } = makeReadBinding({ client: fakeClient() as never, connection: conn, audit: noAudit, tool: "graph_run", maxCalls: 2 });
    await handle("get", ["/a"]);
    await handle("get", ["/b"]);
    await expect(handle("get", ["/c"])).rejects.toThrow(/call limit/);
  });

  describe("inside the sandbox", () => {
    const runner = new SandboxRunner({ timeoutMs: 10_000 });
    afterAll(() => runner.dispose());

    it("works end to end", async () => {
      const client = fakeClient();
      const { handle, calls } = makeReadBinding({ client: client as never, connection: conn, audit: noAudit, tool: "graph_run" });
      const r = await runner.run("const p = await graph.list('/users'); return p.items.map(u => u.id);", handle);
      expect(r.ok).toBe(true);
      expect(r.data).toEqual(["/users-1"]);
      expect(calls()).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/sandbox/binding.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/sandbox/binding-types.ts`**

```ts
/** Type declarations shown to the model in the graph_run tool description. Keep this short. */
export const BINDING_TYPES = `
declare const graph: {
  // One object. await graph.get("/users/{id}", { select: ["displayName"] })
  get(path: string, opts?: QueryOpts): Promise<unknown>;
  // One page. { items, nextCursor }. Default top 50, max 999. Pass opts.cursor for the next page.
  list(path: string, opts?: QueryOpts): Promise<{ items: unknown[]; nextCursor?: string }>;
  // Every page, up to max items (default 2000, hard cap 20000). Items stay in the sandbox.
  all(path: string, opts?: QueryOpts & { max?: number }): Promise<unknown[]>;
  // Up to 20 requests in one $batch call. Results in order. Failed entries are { error: { status, code, message } }.
  batch(requests: Array<{ path: string; opts?: QueryOpts }>): Promise<unknown[]>;
  // Count with $count=true and ConsistencyLevel set for you.
  count(path: string, filter?: string): Promise<number>;
};
interface QueryOpts {
  select?: string[]; filter?: string; expand?: string[]; orderby?: string;
  search?: string; top?: number; beta?: boolean; cursor?: string;
}
// Calls may run in parallel with Promise.all. Each run may make at most 200 calls.
`.trim();
```

- [ ] **Step 4: Write `src/core/sandbox/binding.ts`**

```ts
import type { AuditEvent } from "../audit/logger.js";
import type { GraphClient } from "../graph/client.js";
import { GraphError } from "../graph/errors.js";
import type { Connection, GraphCallRecord, QueryOpts } from "../types.js";
import type { BindingHandler } from "./runner.js";

export interface BindingDeps {
  client: GraphClient;
  connection: Connection;
  audit: { write(event: AuditEvent): Promise<void> };
  tool: string;
  maxCalls?: number;
}

export const DEFAULT_MAX_CALLS = 200;

export function makeReadBinding(deps: BindingDeps): { handle: BindingHandler; calls: () => GraphCallRecord[] } {
  const { client, connection, audit, tool } = deps;
  const maxCalls = deps.maxCalls ?? DEFAULT_MAX_CALLS;
  const records: GraphCallRecord[] = [];
  let started = 0;
  const principal = connection.username ?? `app:${connection.clientId}`;

  async function tracked<T>(method: string, path: string, opts: QueryOpts | undefined, fn: () => Promise<T>): Promise<T> {
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
        throw new Error(`Graph ${err.status} ${err.code}: ${err.message}`);
      }
      status = 0;
      throw err;
    } finally {
      const ms = Date.now() - t0;
      records.push({ method, path, status, ms, apiVersion });
      await audit.write({
        tenant: connection.tenantId,
        principal,
        tool,
        method,
        path,
        query: opts ? JSON.stringify(opts) : undefined,
        status,
        ms,
      });
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
        return tracked("GET", path, opts, () => client.all(connection, path, opts, opts?.max));
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/core/sandbox/binding.test.ts`
Expected: 7 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/core/sandbox/binding.ts src/core/sandbox/binding-types.ts test/core/sandbox/binding.test.ts
git commit -m "Add read-only Graph binding handler with call cap and per-call audit"
```

---

### Task 10: Output capping helper

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/tools/output.ts`
- Test: `test/core/tools/output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { capJson } from "../../../src/core/tools/output.js";

describe("capJson", () => {
  it("returns compact json and no truncation when small", () => {
    const r = capJson({ a: 1, b: [1, 2] }, 1000);
    expect(r.text).toBe('{"a":1,"b":[1,2]}');
    expect(r.truncated).toBe(false);
  });

  it("cuts at the limit and flags truncation", () => {
    const r = capJson({ s: "x".repeat(500) }, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100 + "\n...[truncated]".length);
    expect(r.text.endsWith("...[truncated]")).toBe(true);
  });

  it("handles undefined and circular values", () => {
    expect(capJson(undefined, 10).text).toBe("null");
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(capJson(o, 100).text).toContain("Circular");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/tools/output.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/tools/output.ts`**

```ts
/** About 10,000 tokens at four characters per token. */
export const DEFAULT_MAX_CHARS = 40_000;

export function capJson(value: unknown, maxChars: number = DEFAULT_MAX_CHARS): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    text = JSON.stringify({ error: "Circular or unserialisable value" });
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "\n...[truncated]", truncated: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/tools/output.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/output.ts test/core/tools/output.test.ts
git commit -m "Add compact JSON output capping helper"
```

---

### Task 11: graph_run tool and server factory

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/tools/graph-run.ts`
- Create: `src/core/server.ts`
- Test: `test/core/tools/graph-run.test.ts`

The server factory takes every dependency as an argument so the test can use an in-memory MCP client with fakes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/core/server.js";
import { SandboxRunner } from "../../../src/core/sandbox/runner.js";
import { GRAPH_RUN_DESCRIPTION } from "../../../src/core/tools/graph-run.js";
import type { Connection } from "../../../src/core/types.js";

const sandbox = new SandboxRunner({ timeoutMs: 15_000 });
afterAll(() => sandbox.dispose());

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: [],
  addedAt: "2026-09-15T00:00:00.000Z",
};

function deps() {
  const store = {
    list: async () => [conn],
    resolve: async (k: string) => (k === "contoso" || k === conn.tenantId ? conn : undefined),
    upsert: async () => {},
    remove: async () => false,
  };
  const client = {
    get: vi.fn(async (_c: Connection, path: string) => ({ id: path })),
    list: vi.fn(async () => ({ items: [{ displayName: "A" }, { displayName: "B" }] })),
    all: vi.fn(async () => []),
    batch: vi.fn(async () => []),
    count: vi.fn(async () => 2),
  };
  const audit = { write: vi.fn(async () => {}) };
  const auth = { signInDelegated: vi.fn(), getGraphToken: async () => "tok" };
  return { store, client, audit, auth, sandbox };
}

async function connect(d: ReturnType<typeof deps>) {
  const server = createServer({ store: d.store as never, client: d.client as never, audit: d.audit, auth: d.auth as never, sandbox: d.sandbox });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

describe("graph_run", () => {
  it("is registered read-only with a small description", async () => {
    const mcp = await connect(deps());
    const tools = (await mcp.listTools()).tools;
    const run = tools.find((t) => t.name === "graph_run");
    expect(run).toBeDefined();
    expect(run?.annotations?.readOnlyHint).toBe(true);
    expect(GRAPH_RUN_DESCRIPTION.length).toBeLessThan(8000);
  });

  it("runs a script and returns structured content with calls", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({
      name: "graph_run",
      arguments: { tenant: "contoso", code: "const p = await graph.list('/users'); return p.items.map(u => u.displayName);" },
    });
    const sc = res.structuredContent as { ok: boolean; result: unknown; calls: Array<{ path: string }>; tenant: string; truncated: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.result).toEqual(["A", "B"]);
    expect(sc.calls[0].path).toBe("/users");
    expect(sc.tenant).toBe(conn.tenantId);
    expect(sc.truncated).toBe(false);
    expect(d.audit.write).toHaveBeenCalled();
  });

  it("returns an error result for an unknown tenant", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "graph_run", arguments: { tenant: "nope", code: "return 1;" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("connections_list");
  });

  it("returns ok false with the script error and logs when the script throws", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "graph_run", arguments: { tenant: "contoso", code: "console.log('before'); throw new Error('boom');" } });
    const sc = res.structuredContent as { ok: boolean; error?: { message: string }; logs: string[] };
    expect(sc.ok).toBe(false);
    expect(sc.error?.message).toContain("boom");
    expect(sc.logs).toEqual(["before"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/tools/graph-run.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/core/tools/graph-run.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditEvent } from "../audit/logger.js";
import type { GraphClient } from "../graph/client.js";
import type { ConnectionStore } from "../connections/store.js";
import { BINDING_TYPES } from "../sandbox/binding-types.js";
import { makeReadBinding } from "../sandbox/binding.js";
import type { SandboxRunner } from "../sandbox/runner.js";
import { sha256 } from "../audit/logger.js";
import { capJson } from "./output.js";

export const GRAPH_RUN_DESCRIPTION = `Run a read-only JavaScript script against Microsoft Graph for one tenant. Use this for any read, filter, join, or count. Write the body of an async function and "return" the value you want back. Only what you return (and console.log) comes back to you, so filter and select inside the script. Output is capped at about 10,000 tokens.

Rules the server applies for you: v1.0 by default (pass beta: true per call), ConsistencyLevel and $count for advanced directory queries, Retry-After on throttling, a default $select for known resources. Paths are Graph-relative like "/users" or "/identity/conditionalAccess/policies". Call graph_describe when you are unsure of a path or property. Use connections_list to find tenant aliases.

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
return page.items;`;

export interface GraphRunDeps {
  store: Pick<ConnectionStore, "resolve">;
  client: GraphClient;
  audit: { write(event: AuditEvent): Promise<void> };
  sandbox: Pick<SandboxRunner, "run">;
}

const outputSchema = {
  ok: z.boolean(),
  tenant: z.string(),
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  logs: z.array(z.string()),
  calls: z.array(z.object({ method: z.string(), path: z.string(), status: z.number(), ms: z.number(), apiVersion: z.string() })),
  truncated: z.boolean(),
};

export function registerGraphRunTool(server: McpServer, deps: GraphRunDeps): void {
  server.registerTool(
    "graph_run",
    {
      title: "Run a read-only Graph script",
      description: GRAPH_RUN_DESCRIPTION,
      inputSchema: {
        tenant: z.string().describe("Connection alias or tenant id. See connections_list."),
        code: z.string().describe("Body of an async JavaScript function. Use await graph.* and return a value."),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ tenant, code }) => {
      const connection = await deps.store.resolve(tenant);
      if (!connection) {
        return {
          isError: true,
          content: [{ type: "text", text: `No connection named "${tenant}". Call connections_list to see aliases, or connection_add to sign in.` }],
        };
      }
      const { handle, calls } = makeReadBinding({ client: deps.client, connection, audit: deps.audit, tool: "graph_run" });
      await deps.audit.write({ tenant: connection.tenantId, principal: connection.username ?? `app:${connection.clientId}`, tool: "graph_run", scriptHash: sha256(code), note: "script start" });
      const run = await deps.sandbox.run(code, handle);
      const capped = capJson(run.data);
      const structured = {
        ok: run.ok,
        tenant: connection.tenantId,
        result: run.ok ? (capped.truncated ? capped.text : run.data) : undefined,
        error: run.error ? { name: run.error.name, message: run.error.message } : undefined,
        logs: run.logs,
        calls: calls(),
        truncated: capped.truncated,
      };
      const text = capped.truncated
        ? `${capped.text}\n\nResult was truncated. Narrow the select, add a filter, or return fewer items.`
        : capJson(structured).text;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );
}
```

- [ ] **Step 4: Write `src/core/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditEvent } from "./audit/logger.js";
import type { ConnectionStore } from "./connections/store.js";
import type { GraphClient } from "./graph/client.js";
import type { MsalAuth } from "./auth/msal.js";
import type { SandboxRunner } from "./sandbox/runner.js";
import { registerGraphRunTool } from "./tools/graph-run.js";

export interface ServerDeps {
  store: ConnectionStore;
  client: GraphClient;
  audit: { write(event: AuditEvent): Promise<void> };
  auth: MsalAuth;
  sandbox: Pick<SandboxRunner, "run">;
}

export const SERVER_NAME = "ms-graph-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerGraphRunTool(server, deps);
  return server;
}
```

Create a placeholder `src/core/auth/msal.ts` so the import compiles. Task 12 replaces it:

```ts
import type { TokenProvider } from "./token-provider.js";
import type { Connection } from "../types.js";

export interface SignInResult {
  connection: Connection;
}

export interface MsalAuth extends TokenProvider {
  signInDelegated(input: { alias?: string; tenantHint?: string; scopes?: string[] }): Promise<SignInResult>;
  removeAccount(connection: Connection): Promise<void>;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/core/tools/graph-run.test.ts`
Expected: 4 tests passed.

If `InMemoryTransport` is not exported from `@modelcontextprotocol/sdk/inMemory.js` in the installed version, run `ls node_modules/@modelcontextprotocol/sdk/dist/esm | grep -i memory` and fix the import path.

- [ ] **Step 6: Commit**

```bash
git add src/core/tools/graph-run.ts src/core/server.ts src/core/auth/msal.ts test/core/tools/graph-run.test.ts
git commit -m "Add graph_run tool and server factory"
```

---

### Task 12: MSAL delegated sign-in and silent tokens

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Modify: `src/core/auth/msal.ts` (replace the placeholder)
- Test: `test/core/auth/msal.test.ts`

This module wraps MSAL Node. Tests use a fake `PublicClientApplication` passed through the constructor so no network or browser is needed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { MsalAuthImpl } from "../../../src/core/auth/msal.js";
import type { Connection } from "../../../src/core/types.js";

function fakePca() {
  const accounts: Array<{ homeAccountId: string; username: string; tenantId: string }> = [];
  return {
    accounts,
    acquireTokenInteractive: vi.fn(async (req: { scopes: string[] }) => {
      const account = { homeAccountId: "home-1", username: "admin@contoso.com", tenantId: "00000000-0000-0000-0000-000000000001" };
      accounts.push(account);
      return { accessToken: "interactive-token", account, scopes: req.scopes };
    }),
    acquireTokenSilent: vi.fn(async (req: { account: { homeAccountId: string } }) => {
      if (!accounts.find((a) => a.homeAccountId === req.account.homeAccountId)) throw new Error("no account");
      return { accessToken: "silent-token" };
    }),
    getTokenCache: () => ({
      getAllAccounts: async () => accounts,
      removeAccount: vi.fn(async (a: { homeAccountId: string }) => {
        const i = accounts.findIndex((x) => x.homeAccountId === a.homeAccountId);
        if (i >= 0) accounts.splice(i, 1);
      }),
    }),
  };
}

describe("MsalAuthImpl", () => {
  it("signs in interactively and builds a delegated connection", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });
    const { connection } = await auth.signInDelegated({ alias: "contoso", scopes: ["User.Read"] });
    expect(connection).toMatchObject({
      alias: "contoso",
      tenantId: "00000000-0000-0000-0000-000000000001",
      tenantName: "Contoso",
      kind: "delegated",
      clientId: "cid",
      homeAccountId: "home-1",
      username: "admin@contoso.com",
      scopes: ["User.Read"],
    });
    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: ["User.Read"] });
  });

  it("defaults the alias to the tenant name slug", async () => {
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => fakePca() as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso Ltd" });
    const { connection } = await auth.signInDelegated({});
    expect(connection.alias).toBe("contoso-ltd");
  });

  it("gets a silent token for a stored connection", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });
    const { connection } = await auth.signInDelegated({ alias: "c" });
    expect(await auth.getGraphToken(connection)).toBe("silent-token");
  });

  it("fails clearly when the account is gone", async () => {
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => fakePca() as never, openBrowser: async () => {}, lookupTenantName: async () => "x" });
    const conn: Connection = { alias: "c", tenantId: "t", kind: "delegated", clientId: "cid", homeAccountId: "missing", scopes: [], addedAt: "" };
    await expect(auth.getGraphToken(conn)).rejects.toThrow(/sign in again/);
  });

  it("removes the account from the cache", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "x" });
    const { connection } = await auth.signInDelegated({ alias: "c" });
    await auth.removeAccount(connection);
    expect(pca.accounts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/auth/msal.test.ts`
Expected: FAIL, `MsalAuthImpl` is not exported.

- [ ] **Step 3: Replace `src/core/auth/msal.ts`**

```ts
import { PublicClientApplication, type Configuration } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import open from "open";
import { DEFAULT_SIGNIN_SCOPES, GRAPH_ORIGIN, GRAPH_SCOPE_DEFAULT, LOGIN_AUTHORITY_BASE, type Config } from "../config.js";
import type { Connection } from "../types.js";
import type { TokenProvider } from "./token-provider.js";

export interface SignInResult {
  connection: Connection;
}

export interface MsalAuth extends TokenProvider {
  signInDelegated(input: { alias?: string; tenantHint?: string; scopes?: string[] }): Promise<SignInResult>;
  removeAccount(connection: Connection): Promise<void>;
}

/** The subset of PublicClientApplication this module uses. Tests pass a fake. */
export interface PcaLike {
  acquireTokenInteractive(req: {
    scopes: string[];
    openBrowser: (url: string) => Promise<void>;
    successTemplate?: string;
    errorTemplate?: string;
  }): Promise<{ accessToken: string; account: { homeAccountId: string; username: string; tenantId: string } | null; scopes: string[] }>;
  acquireTokenSilent(req: { scopes: string[]; account: { homeAccountId: string } }): Promise<{ accessToken: string }>;
  getTokenCache(): {
    getAllAccounts(): Promise<Array<{ homeAccountId: string; username: string; tenantId: string }>>;
    removeAccount(account: { homeAccountId: string }): Promise<void>;
  };
}

export interface MsalAuthOptions {
  clientId: string;
  /** Builds a client for the given authority. Defaults to a real PublicClientApplication. */
  pcaFactory?: (authority: string) => PcaLike | Promise<PcaLike>;
  openBrowser?: (url: string) => Promise<void>;
  /** Looks up the tenant display name with a fresh token. Defaults to GET /organization. */
  lookupTenantName?: (accessToken: string) => Promise<string | undefined>;
}

export class MsalAuthImpl implements MsalAuth {
  private readonly clientId: string;
  private readonly pcaFactory: (authority: string) => PcaLike | Promise<PcaLike>;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly lookupTenantName: (accessToken: string) => Promise<string | undefined>;
  private readonly pcas = new Map<string, PcaLike>();

  constructor(opts: MsalAuthOptions) {
    this.clientId = opts.clientId;
    this.pcaFactory = opts.pcaFactory ?? ((authority) => new PublicClientApplication({ auth: { clientId: this.clientId, authority } }) as unknown as PcaLike);
    this.openBrowser = opts.openBrowser ?? (async (url) => { await open(url); });
    this.lookupTenantName = opts.lookupTenantName ?? defaultLookupTenantName;
  }

  private async pca(tenant: string): Promise<PcaLike> {
    const authority = `${LOGIN_AUTHORITY_BASE}/${tenant}`;
    let p = this.pcas.get(authority);
    if (!p) {
      p = await this.pcaFactory(authority);
      this.pcas.set(authority, p);
    }
    return p;
  }

  async signInDelegated(input: { alias?: string; tenantHint?: string; scopes?: string[] }): Promise<SignInResult> {
    const scopes = input.scopes?.length ? input.scopes : DEFAULT_SIGNIN_SCOPES;
    const pca = await this.pca(input.tenantHint ?? "organizations");
    const result = await pca.acquireTokenInteractive({
      scopes,
      openBrowser: this.openBrowser,
      successTemplate: "<h1>Signed in. You can close this window.</h1>",
      errorTemplate: "<h1>Sign-in failed.</h1><p>Return to your MCP client for details.</p>",
    });
    if (!result.account) throw new Error("Sign-in returned no account");
    const tenantName = await this.lookupTenantName(result.accessToken).catch(() => undefined);
    const alias = input.alias ?? slug(tenantName ?? result.account.tenantId);
    return {
      connection: {
        alias,
        tenantId: result.account.tenantId,
        tenantName,
        kind: "delegated",
        clientId: this.clientId,
        homeAccountId: result.account.homeAccountId,
        username: result.account.username,
        scopes: result.scopes ?? scopes,
        addedAt: new Date().toISOString(),
      },
    };
  }

  async getGraphToken(connection: Connection): Promise<string> {
    if (connection.kind !== "delegated" || !connection.homeAccountId) {
      throw new Error(`Connection "${connection.alias}" is not a delegated connection`);
    }
    const pca = await this.pca(connection.tenantId);
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account = accounts.find((a) => a.homeAccountId === connection.homeAccountId);
    if (!account) throw new Error(`No cached sign-in for "${connection.alias}". Run connection_add to sign in again.`);
    try {
      const res = await pca.acquireTokenSilent({ scopes: [GRAPH_SCOPE_DEFAULT], account });
      return res.accessToken;
    } catch (err) {
      throw new Error(`Token refresh failed for "${connection.alias}". Run connection_add to sign in again. (${(err as Error).message})`);
    }
  }

  async removeAccount(connection: Connection): Promise<void> {
    if (!connection.homeAccountId) return;
    const pca = await this.pca(connection.tenantId);
    const cache = pca.getTokenCache();
    const account = (await cache.getAllAccounts()).find((a) => a.homeAccountId === connection.homeAccountId);
    if (account) await cache.removeAccount(account);
  }
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tenant";
}

async function defaultLookupTenantName(accessToken: string): Promise<string | undefined> {
  const res = await fetch(`${GRAPH_ORIGIN}/v1.0/organization?$select=displayName`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { value?: Array<{ displayName?: string }> };
  return body.value?.[0]?.displayName;
}

/** Builds the real PublicClientApplication with the OS keychain cache. Used by the stdio entry point. */
export async function makeRealPcaFactory(config: Config): Promise<(authority: string) => Promise<PcaLike>> {
  let cachePlugin: PersistenceCachePlugin | undefined;
  if (config.tokenCacheEnabled) {
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: config.msalCacheFile,
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "ms-graph-mcp",
      accountName: "msal-token-cache",
      usePlaintextFileOnLinux: false,
    });
    cachePlugin = new PersistenceCachePlugin(persistence);
  }
  return async (authority: string) => {
    const configuration: Configuration = {
      auth: { clientId: config.clientId, authority },
      ...(cachePlugin ? { cache: { cachePlugin } } : {}),
    };
    return new PublicClientApplication(configuration) as unknown as PcaLike;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/auth/msal.test.ts`
Expected: 5 tests passed.

Run: `npm run typecheck`
Expected: exit code 0. If the `PcaLike` cast on `PublicClientApplication` fails to compile, keep the `as unknown as PcaLike` cast and do not widen `PcaLike`.

- [ ] **Step 5: Commit**

```bash
git add src/core/auth/msal.ts test/core/auth/msal.test.ts
git commit -m "Add MSAL delegated sign-in with keychain token cache"
```

---

### Task 13: Connection tools

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/core/tools/connections.ts`
- Modify: `src/core/server.ts`
- Test: `test/core/tools/connections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/core/server.js";
import type { Connection } from "../../../src/core/types.js";

const conn: Connection = {
  alias: "contoso",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantName: "Contoso",
  kind: "delegated",
  clientId: "x",
  username: "admin@contoso.com",
  scopes: ["User.Read"],
  addedAt: "2026-09-15T00:00:00.000Z",
};

function deps() {
  const list: Connection[] = [conn];
  const store = {
    list: async () => list.slice(),
    resolve: async (k: string) => list.find((c) => c.alias === k || c.tenantId === k),
    upsert: vi.fn(async (c: Connection) => { list.push(c); }),
    remove: vi.fn(async (alias: string) => {
      const i = list.findIndex((c) => c.alias === alias);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    }),
  };
  const auth = {
    signInDelegated: vi.fn(async (input: { alias?: string; scopes?: string[] }) => ({
      connection: { ...conn, alias: input.alias ?? "fabrikam", tenantId: "00000000-0000-0000-0000-000000000002", scopes: input.scopes ?? ["User.Read"] },
    })),
    getGraphToken: async () => "tok",
    removeAccount: vi.fn(async () => {}),
  };
  const client = { get: vi.fn(), list: vi.fn(), all: vi.fn(), batch: vi.fn(), count: vi.fn() };
  const audit = { write: vi.fn(async () => {}) };
  const sandbox = { run: vi.fn() };
  return { store, auth, client, audit, sandbox };
}

async function connect(d: ReturnType<typeof deps>) {
  const server = createServer({ store: d.store as never, client: d.client as never, audit: d.audit, auth: d.auth as never, sandbox: d.sandbox });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(ct);
  return mcp;
}

describe("connection tools", () => {
  it("lists connections without secrets", async () => {
    const mcp = await connect(deps());
    const res = await mcp.callTool({ name: "connections_list", arguments: {} });
    const sc = res.structuredContent as { connections: Array<Record<string, unknown>> };
    expect(sc.connections).toHaveLength(1);
    expect(sc.connections[0]).toMatchObject({ alias: "contoso", tenantId: conn.tenantId, kind: "delegated", username: "admin@contoso.com" });
    expect(Object.keys(sc.connections[0])).not.toContain("homeAccountId");
  });

  it("adds a connection through interactive sign-in and rejects unknown scopes", async () => {
    const d = deps();
    const mcp = await connect(d);
    const bad = await mcp.callTool({ name: "connection_add", arguments: { alias: "f", scopes: ["not a scope"] } });
    expect(bad.isError).toBe(true);
    const res = await mcp.callTool({ name: "connection_add", arguments: { alias: "fabrikam", scopes: ["Group.Read.All"] } });
    expect(res.isError).toBeFalsy();
    expect(d.store.upsert).toHaveBeenCalledWith(expect.objectContaining({ alias: "fabrikam" }));
    expect(d.audit.write).toHaveBeenCalledWith(expect.objectContaining({ tool: "connection_add", note: expect.stringContaining("Group.Read.All") }));
  });

  it("removes a connection and its cached account", async () => {
    const d = deps();
    const mcp = await connect(d);
    const res = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });
    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect(d.auth.removeAccount).toHaveBeenCalled();
    const again = await mcp.callTool({ name: "connection_remove", arguments: { alias: "contoso" } });
    expect((again.structuredContent as { removed: boolean }).removed).toBe(false);
  });

  it("declares annotations", async () => {
    const mcp = await connect(deps());
    const tools = (await mcp.listTools()).tools;
    expect(tools.find((t) => t.name === "connections_list")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "connection_remove")?.annotations?.destructiveHint).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/tools/connections.test.ts`
Expected: FAIL, tool `connections_list` not found.

- [ ] **Step 3: Write `src/core/tools/connections.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditEvent } from "../audit/logger.js";
import type { MsalAuth } from "../auth/msal.js";
import type { ConnectionStore } from "../connections/store.js";
import type { Connection } from "../types.js";
import { capJson } from "./output.js";

export interface ConnectionToolDeps {
  store: Pick<ConnectionStore, "list" | "resolve" | "upsert" | "remove">;
  auth: Pick<MsalAuth, "signInDelegated" | "removeAccount">;
  audit: { write(event: AuditEvent): Promise<void> };
}

/** Graph permission names look like Resource.Action or Resource.Action.Scope, e.g. User.Read.All. */
const SCOPE_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9-]*){1,3}$/;

function publicView(c: Connection) {
  return { alias: c.alias, tenantId: c.tenantId, tenantName: c.tenantName, kind: c.kind, clientId: c.clientId, username: c.username, scopes: c.scopes, addedAt: c.addedAt };
}

const connectionShape = z.object({
  alias: z.string(),
  tenantId: z.string(),
  tenantName: z.string().optional(),
  kind: z.enum(["delegated", "app"]),
  clientId: z.string(),
  username: z.string().optional(),
  scopes: z.array(z.string()),
  addedAt: z.string(),
});

export function registerConnectionTools(server: McpServer, deps: ConnectionToolDeps): void {
  server.registerTool(
    "connections_list",
    {
      title: "List tenant connections",
      description: "List the signed-in tenant connections. Use the alias or tenant id as the tenant argument of other tools.",
      inputSchema: {},
      outputSchema: { connections: z.array(connectionShape) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const connections = (await deps.store.list()).map(publicView);
      return { content: [{ type: "text", text: capJson({ connections }).text }], structuredContent: { connections } };
    },
  );

  server.registerTool(
    "connection_add",
    {
      title: "Sign in to a tenant",
      description:
        "Open the browser so a person can sign in to a Microsoft 365 tenant and consent to scopes. Delegated only. Never pass tokens or secrets. For app-only connections, the person runs `ms-graph-mcp connect --app-only` in a terminal.",
      inputSchema: {
        alias: z.string().optional().describe("Short name for the connection. Defaults to the tenant name."),
        tenantHint: z.string().optional().describe("Tenant id or verified domain to sign into. Defaults to any organization."),
        scopes: z.array(z.string()).optional().describe("Delegated Graph permissions to request, e.g. User.Read.All. Defaults to a read set."),
      },
      outputSchema: { connection: connectionShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ alias, tenantHint, scopes }) => {
      const bad = (scopes ?? []).filter((s) => !SCOPE_RE.test(s));
      if (bad.length) {
        return { isError: true, content: [{ type: "text", text: `These do not look like Graph permission names: ${bad.join(", ")}` }] };
      }
      await deps.audit.write({ tenant: tenantHint ?? "organizations", principal: "interactive", tool: "connection_add", note: `sign-in requested with scopes ${(scopes ?? []).join(" ") || "(default)"}` });
      const { connection } = await deps.auth.signInDelegated({ alias, tenantHint, scopes });
      await deps.store.upsert(connection);
      await deps.audit.write({ tenant: connection.tenantId, principal: connection.username ?? "interactive", tool: "connection_add", note: `signed in as ${connection.username} with scopes ${connection.scopes.join(" ")}` });
      const view = publicView(connection);
      return { content: [{ type: "text", text: capJson({ connection: view }).text }], structuredContent: { connection: view } };
    },
  );

  server.registerTool(
    "connection_remove",
    {
      title: "Remove a tenant connection",
      description: "Remove a stored connection and its cached sign-in.",
      inputSchema: { alias: z.string() },
      outputSchema: { removed: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ alias }) => {
      const existing = await deps.store.resolve(alias);
      if (existing) await deps.auth.removeAccount(existing);
      const removed = await deps.store.remove(alias);
      if (removed) await deps.audit.write({ tenant: existing?.tenantId ?? alias, principal: existing?.username ?? "interactive", tool: "connection_remove", note: `removed ${alias}` });
      return { content: [{ type: "text", text: JSON.stringify({ removed }) }], structuredContent: { removed } };
    },
  );
}
```

- [ ] **Step 4: Register the tools in `src/core/server.ts`**

Add the import and the call:

```ts
import { registerConnectionTools } from "./tools/connections.js";
```

Inside `createServer`, after `registerGraphRunTool(server, deps);`:

```ts
  registerConnectionTools(server, deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/core/tools/connections.test.ts`
Expected: 4 tests passed.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/tools/connections.ts src/core/server.ts test/core/tools/connections.test.ts
git commit -m "Add connections_list, connection_add, and connection_remove tools"
```

---

### Task 14: Stdio entry point, CLI, and README

**Worker:** Codex, `gpt-5.6-sol`, effort high.

**Files:**
- Create: `src/transport/stdio/main.ts`
- Create: `src/cli/main.ts`
- Create: `README.md`
- Test: `test/cli/main.test.ts`

The single bin starts the stdio server when run with no arguments, which is what the MCP client config does. With `connect` it runs an interactive sign-in from the terminal, which also gives people a way to sign in when the tool cannot open a browser.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/main.js";

describe("parseArgs", () => {
  it("defaults to serve", () => {
    expect(parseArgs([])).toEqual({ command: "serve" });
  });
  it("parses connect with options", () => {
    expect(parseArgs(["connect", "--alias", "contoso", "--tenant", "contoso.com", "--scopes", "User.Read.All,Group.Read.All"])).toEqual({
      command: "connect",
      alias: "contoso",
      tenantHint: "contoso.com",
      scopes: ["User.Read.All", "Group.Read.All"],
    });
  });
  it("parses connections and help", () => {
    expect(parseArgs(["connections"])).toEqual({ command: "connections" });
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
  });
  it("rejects unknown commands", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/Unknown command/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/cli/main.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/transport/stdio/main.ts`**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLogger } from "../../core/audit/logger.js";
import { MsalAuthImpl, makeRealPcaFactory } from "../../core/auth/msal.js";
import { resolveConfig } from "../../core/config.js";
import { ConnectionStore } from "../../core/connections/store.js";
import { GraphClient } from "../../core/graph/client.js";
import { SandboxRunner } from "../../core/sandbox/runner.js";
import { createServer } from "../../core/server.js";

export async function buildDeps() {
  const config = resolveConfig();
  const store = new ConnectionStore(config.connectionsFile);
  const audit = new AuditLogger(config.auditDir);
  const auth = new MsalAuthImpl({ clientId: config.clientId, pcaFactory: await makeRealPcaFactory(config) });
  const client = new GraphClient(auth);
  // The runtime is started on the first run, so the CLI commands never spawn workerd.
  const sandbox = new SandboxRunner();
  return { config, store, audit, auth, client, sandbox };
}

export async function startStdioServer(): Promise<void> {
  const deps = await buildDeps();
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  const shutdown = () => {
    void deps.sandbox.dispose().finally(() => process.exit(0));
  };
  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
  // Never write to stdout here. Stdout is the MCP channel.
  process.stderr.write(`ms-graph-mcp ready. Home: ${deps.config.homeDir}\n`);
}
```

- [ ] **Step 4: Write `src/cli/main.ts`**

```ts
#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildDeps, startStdioServer } from "../transport/stdio/main.js";

export type CliArgs =
  | { command: "serve" }
  | { command: "help" }
  | { command: "connections" }
  | { command: "connect"; alias?: string; tenantHint?: string; scopes?: string[] };

export function parseArgs(argv: string[]): CliArgs {
  const [cmd, ...rest] = argv;
  if (!cmd) return { command: "serve" };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return { command: "help" };
  if (cmd === "connections") return { command: "connections" };
  if (cmd === "connect") {
    const out: { command: "connect"; alias?: string; tenantHint?: string; scopes?: string[] } = { command: "connect" };
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      if (flag === "--alias") out.alias = value;
      else if (flag === "--tenant") out.tenantHint = value;
      else if (flag === "--scopes") out.scopes = value.split(",").map((s) => s.trim()).filter(Boolean);
      else throw new Error(`Unknown option ${flag}`);
    }
    return out;
  }
  throw new Error(`Unknown command "${cmd}". Run with --help.`);
}

const HELP = `ms-graph-mcp

  ms-graph-mcp                 Start the MCP server on stdio (what your MCP client runs)
  ms-graph-mcp connect         Sign in to a tenant in the browser and store the connection
      --alias <name>           Short name for the connection
      --tenant <id|domain>     Tenant to sign into (default: any organization)
      --scopes a,b,c           Delegated Graph permissions to request
  ms-graph-mcp connections     List stored connections
`;

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "serve") return startStdioServer();
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const deps = await buildDeps();
  if (args.command === "connections") {
    for (const c of await deps.store.list()) {
      process.stdout.write(`${c.alias}\t${c.tenantId}\t${c.tenantName ?? ""}\t${c.kind}\t${c.username ?? ""}\n`);
    }
    return;
  }
  const { connection } = await deps.auth.signInDelegated({ alias: args.alias, tenantHint: args.tenantHint, scopes: args.scopes });
  await deps.store.upsert(connection);
  await deps.audit.write({ tenant: connection.tenantId, principal: connection.username ?? "interactive", tool: "cli connect", note: `signed in with scopes ${connection.scopes.join(" ")}` });
  process.stdout.write(`Connected "${connection.alias}" (${connection.tenantName ?? connection.tenantId}) as ${connection.username}\n`);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Write `README.md`**

````markdown
# ms-graph-mcp

An MCP server for Microsoft Graph. The model writes a short read-only script that runs in a sandbox against a typed, guarded Graph client, so only the result it asked for comes back. Writes go through a separate tool with a dry run and a confirmation step (coming in a later release).

## Install

Add this to your MCP client config. Claude Desktop, Claude Code, and VS Code all accept the same shape.

```json
{
  "mcpServers": {
    "ms-graph-mcp": {
      "command": "npx",
      "args": ["-y", "ms-graph-mcp"]
    }
  }
}
```

## First sign-in

Ask the model to add a connection, or run this in a terminal:

```bash
npx -y ms-graph-mcp connect --alias contoso
```

A browser window opens. Sign in with a work account and approve the requested read permissions. The sign-in is cached in your operating system keychain. Tokens and secrets never pass through the model.

## How scripts run

Scripts run in a fresh V8 isolate inside Cloudflare's open source `workerd` runtime, which the server starts on your machine through Miniflare. The isolate has no filesystem and no network. Its only way out is a call back into this server, which holds your token and makes the Graph request. The install is about 170 MB because it includes the `workerd` binary for your platform.

## Tools

- `connections_list`, `connection_add`, `connection_remove`
- `graph_run`: run a read-only script. Example the model might write:

```js
const p = await graph.all("/identity/conditionalAccess/policies", { select: ["id", "displayName", "state"] });
return p.filter(x => x.state === "enabled").map(x => x.displayName);
```

## Configuration

| Variable | Meaning |
|---|---|
| `MSGRAPH_MCP_HOME` | Directory for connections, audit logs, and token cache. Default `~/.ms-graph-mcp`. |
| `MSGRAPH_MCP_CLIENT_ID` | Your own Entra app registration (public client). Default is the Microsoft Graph Command Line Tools app. |
| `MSGRAPH_MCP_NO_TOKEN_CACHE` | Set to `1` to keep tokens in memory only. |

## Audit

Every Graph call is appended as one JSON line to `~/.ms-graph-mcp/audit/YYYY-MM-DD.ndjson` with tenant, principal, tool, method, path, query, status, and duration.

## Development

```bash
npm install
npm test
npm run build
node dist/cli/main.js --help
```
````

- [ ] **Step 6: Run test, typecheck, and build**

Run: `npm test -- test/cli/main.test.ts`
Expected: 4 tests passed.

Run: `npm run typecheck && npm run build && node dist/cli/main.js --help`
Expected: the help text prints.

- [ ] **Step 7: Manual smoke test with a real client**

This step needs a person with a Microsoft 365 account. Record the result in the worker report. Do not commit any file under the home directory.

1. Run `node dist/cli/main.js connect --alias test` and complete the browser sign-in.
2. Run `node dist/cli/main.js connections` and confirm the alias appears.
3. Add the server to Claude Code with the absolute path: `claude mcp add ms-graph-mcp -- node /Users/arnoldd/ms-graph-mcp/dist/cli/main.js`
4. In Claude Code ask: "Using graph_run on tenant test, count enabled users." Confirm a number comes back and that `~/.ms-graph-mcp/audit/` has a file with a `/users/$count` line.

- [ ] **Step 8: Commit**

```bash
git add src/transport/stdio/main.ts src/cli/main.ts README.md test/cli/main.test.ts
git commit -m "Add stdio entry point, connect CLI, and README"
```

---

### Task 15: Open the pull request

**Worker:** main session (Fable), not a Codex worker, because the PR body needs the conversation history.

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feature/plan-1-core
gh pr create --base main --head feature/plan-1-core --title "Plan 1: core and read path" --body-file <body written by the main session, including the required "How this evolved" section>
```

- [ ] **Step 2: Request review**

Dispatch a Sonnet 5 subagent, effort medium, to review the full diff against the spec sections "Connections", "Graph client", "Sandbox", "Audit", "graph_run", and "connections_list, connection_add, connection_remove". Fix anything it finds, push, then merge with `gh pr merge --squash`.

---

## Self-review against the spec

- Connections: Task 3 store, Task 12 sign-in, Task 13 tools. Covered.
- Graph client rules: v1.0 default, consistency header and `$count`, `Retry-After`, compact JSON, tenant and version stamping. Tasks 4 to 6 and 11. Default `$select` per resource depends on the Graph index and moves to plan 2. Noted.
- Graph index and `graph_describe`: plan 2.
- Policy engine, `graph_write`, `policy_show`, app-only CLI: plan 3.
- Sandbox in a `workerd` isolate with a Node-side deadline and runtime restart, no network except the binding, no filesystem: Task 8. Call cap and per-call audit: Task 9. Memory is not enforced locally; item and result caps cover it (Tasks 6 and 10).
- Audit per call with body hash: Tasks 7 and 9.
- `graph_run` output cap and truncation flag: Tasks 10 and 11. Description under two thousand tokens: asserted in Task 11.
- Error mapping: 403 to permission name and 404 suggestions need the index, plan 2. Script errors with logs: Task 11. Throttling retry: Task 5.
- Token budget test for tool list size and a shaped users page: plan 2, once default select exists.
- Task tools: plan 4.
