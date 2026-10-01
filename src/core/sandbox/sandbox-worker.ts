/**
 * Source of the host worker that runs inside workerd. It receives { code, runId, maxLogLines, maxLogChars },
 * creates a fresh isolate through the Worker Loader, and returns the isolate's result as JSON.
 * Written without template literals so nothing in it is interpolated by TypeScript.
 */
export const HOST_WORKER_SOURCE = [
  "export default {",
  "  async fetch(request, env) {",
  "    const { code, runId, maxLogLines, maxLogChars } = await request.json();",
  // The preamble is a binding, not a field of the request, so it is fixed when the sandbox
  // is built rather than chosen per run.
  '    const preamble = env.PREAMBLE || "";',
  "    let out;",
  "    try {",
  '      const worker = env.LOADER.get("run-" + runId, () => ({',
  '        compatibilityDate: "2026-01-12",',
  // `?? null` is load-bearing. The Worker Loader reads an undefined outbound as "inherit the
  // parent's outbound", so a bare `env.GRAPH` would hand a sandbox built without the service
  // binding the real internet. Only an explicit null means no network. ADR-0008.
  "        globalOutbound: env.GRAPH ?? null,",
  '        mainModule: "sandbox.js",',
  '        modules: { "sandbox.js": sandboxModule(code, runId, maxLogLines, maxLogChars, preamble) },',
  "      }));",
  "      out = await worker.getEntrypoint().evaluate();",
  "    } catch (e) {",
  '      out = { ok: false, error: { name: (e && e.name) || "Error", message: (e && e.message) || String(e) }, logs: [] };',
  "    }",
  '    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });',
  "  },",
  "};",
  "",
  "function sandboxModule(code, runId, maxLogLines, maxLogChars, preamble) {",
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
  "    '  if (__logChars + line.length > __maxChars) { if (__logChars <= __maxChars) { __logs.push(\"[log output truncated]\"); __logChars = __maxChars + 1; } return; }',",
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
  "    '  request: function (req) { return __call(\"request\", [req]); },',",
  "    '};',",
  "    preamble,",
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

/**
 * Lines the sandbox module puts before the script when the sandbox was built without a
 * preamble, so a stack frame at `sandbox.js:N` is the script's own line
 * `N - SANDBOX_SCRIPT_LINE_OFFSET`. A preamble occupies the one line already counted here,
 * plus one for each line break it carries: see `scriptLineOffset`.
 * A test in test/transport/stdio/miniflare-sandbox.test.ts pins this, so it fails if the
 * lines the module puts above the script ever change.
 */
export const SANDBOX_SCRIPT_LINE_OFFSET = 34;

/**
 * Lines above the script for a sandbox built with this preamble. The breaks are counted rather
 * than split on, because the index sandbox's preamble is the whole Graph index on one line and
 * splitting it would copy megabytes to learn there are none.
 */
export function scriptLineOffset(preamble: string): number {
  let breaks = 0;
  for (let at = preamble.indexOf("\n"); at !== -1; at = preamble.indexOf("\n", at + 1)) breaks += 1;
  return SANDBOX_SCRIPT_LINE_OFFSET + breaks;
}
