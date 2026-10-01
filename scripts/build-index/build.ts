/**
 * Regenerate the Graph index a maintainer ships.
 *
 *   npm run build:index            # v1.0, into data/graph-index.json
 *   npm run build:index -- beta    # beta, into data/graph-index-beta.json
 *
 * This runs on a machine at release time and never in a Worker: peak memory is several
 * hundred megabytes, against a Worker's 128 MB. Sources are cached under .cache/graph-metadata
 * and reused, so a rebuild after a code change costs no network.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  assembleIndex,
  type BuildReport,
  type GraphApiVersion,
  INDEX_SIZE_LIMIT_BYTES,
  indexFileName,
} from "./assemble.ts";
import type { OpenApiDocument } from "./openapi.ts";
import { deriveGovRemovals } from "./removals.ts";
import { readScopes } from "./scopes.ts";
import { ensureSources } from "./sources.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDirectory = resolve(process.env.GRAPH_INDEX_CACHE_DIR ?? resolve(repositoryRoot, ".cache/graph-metadata"));
const dataDirectory = resolve(process.env.GRAPH_INDEX_OUT_DIR ?? resolve(repositoryRoot, "data"));

function removalsFileName(version: GraphApiVersion): string {
  return version === "v1.0" ? "graph-index.usgov.removals.json" : "graph-index-beta.usgov.removals.json";
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function reportLines(report: BuildReport, bytes: number, timings: Record<string, number>, peakRssBytes: number): string[] {
  const untyped = Object.entries(report.untypedByKind)
    .sort(([, a], [, b]) => b - a)
    .map(([kind, count]) => `${kind} ${count.toLocaleString()}`)
    .join(", ");

  return [
    `paths                ${report.paths.toLocaleString()}`,
    `entity types resolved ${report.typedPaths.toLocaleString()} of ${report.paths.toLocaleString()}`,
    `untyped by kind      ${untyped}`,
    `unclassified         ${report.unclassifiedPaths.length}`,
    `types                ${report.types.toLocaleString()}`,
    `unresolved types     ${report.unresolvedEntityTypes.length}`,
    `consistency paths    ${report.consistencyPaths.toLocaleString()}`,
    `scopes joined        ${report.scopeCoverage.matched.toLocaleString()} of ${report.scopeCoverage.paths.toLocaleString()}`,
    `default $select      ${report.defaultSelect.types} types, reaching ${report.defaultSelect.paths.toLocaleString()} paths`,
    `size                 ${megabytes(bytes)} (limit ${megabytes(INDEX_SIZE_LIMIT_BYTES)})`,
    `peak memory          ${megabytes(peakRssBytes)}`,
    `timings (ms)         ${Object.entries(timings).map(([name, ms]) => `${name} ${Math.round(ms)}`).join(", ")}`,
  ];
}

/** Name the things a maintainer has to look at, rather than leaving them as a count. */
function printList(heading: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`\n  ${heading} (${items.length}):`);
  for (const item of items) console.log(`    ${item}`);
}

async function build(version: GraphApiVersion, refresh: boolean): Promise<void> {
  const started = performance.now();
  await ensureSources(cacheDirectory, { refresh, log: (message) => console.log(message) });

  const parseStarted = performance.now();
  const openapi = JSON.parse(await readFile(resolve(cacheDirectory, `openapi-${version}.json`), "utf8")) as OpenApiDocument;
  const openapiMs = performance.now() - parseStarted;

  const csdl = await readFile(resolve(cacheDirectory, `csdl-${version}.xml`), "utf8");
  const govCsdl = await readFile(resolve(cacheDirectory, `csdl-usgov-${version}.xml`), "utf8");
  const permissions = JSON.parse(await readFile(resolve(cacheDirectory, "permissions.json"), "utf8")) as unknown;
  const readMs = performance.now() - parseStarted;

  const assembleStarted = performance.now();
  const { index, report } = assembleIndex({
    version,
    builtAt: new Date().toISOString().slice(0, 10),
    openapi,
    csdl,
    scopes: readScopes(permissions),
  });
  const assembleMs = performance.now() - assembleStarted;

  const json = JSON.stringify(index);
  const bytes = Buffer.byteLength(json);
  await writeFile(resolve(dataDirectory, indexFileName(version)), json);

  const removalsStarted = performance.now();
  const removals = deriveGovRemovals(index, csdl, govCsdl);
  const removalsJson = JSON.stringify(removals);
  const removalsBytes = Buffer.byteLength(removalsJson);
  await writeFile(resolve(dataDirectory, removalsFileName(version)), removalsJson);
  const removalsMs = performance.now() - removalsStarted;

  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const timings = {
    readAndParse: readMs,
    openapiParse: openapiMs,
    assemble: assembleMs,
    govRemovals: removalsMs,
    total: performance.now() - started,
  };
  console.log(`\n${version}`);
  for (const line of reportLines(report, bytes, timings, peakRssBytes)) console.log(`  ${line}`);
  console.log(`  Gov removals         ${removals.length.toLocaleString()} paths, ${removalsBytes.toLocaleString()} bytes`);

  printList("untyped paths that fit no known kind", report.unclassifiedPaths);
  printList("type names a path resolved to that are neither a type nor an enum", report.unresolvedEntityTypes);

  await writeFile(
    resolve(dataDirectory, `${indexFileName(version).replace(/\.json$/, "")}.report.json`),
    `${JSON.stringify({ ...report, bytes, peakRssBytes, timingsMs: timings, builtAt: index.builtAt }, null, 2)}\n`,
  );

  if (bytes > INDEX_SIZE_LIMIT_BYTES) {
    throw new Error(`${indexFileName(version)} is ${megabytes(bytes)}, over the ${megabytes(INDEX_SIZE_LIMIT_BYTES)} limit`);
  }
}

// Only run when invoked as a command. Importing this module must never rebuild the artifact,
// because a test that reaches for one of its exports would rewrite the file it is asserting on.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const requested = args.find((argument) => !argument.startsWith("--")) ?? "v1.0";
  if (requested !== "v1.0" && requested !== "beta") {
    console.error(`usage: npm run build:index -- [v1.0|beta] [--refresh]  (got ${requested})`);
    process.exit(1);
  }
  await build(requested, refresh);
}
