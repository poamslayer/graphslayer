/**
 * Rank the index's read scopes by how much of Graph each one unlocks, and emit the shortlist a
 * maintainer picks the shipped read template from.
 *
 *   npm run rank:read-scopes
 *
 * ADR-0012 is why this exists rather than "ask for every read scope": Entra caps a delegated
 * consent request at about 155 permissions and the index holds 281 read scopes, so the shipped
 * list is a cut. This script makes the cut measurable; it does not make it. Ranking alone would
 * include scopes nobody needs and drop ones used weekly, so what it emits is a shortlist and a
 * person chooses from it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyScope, DELEGATED_CONSENT_CEILING, READ_TEMPLATE_SCOPES } from "../src/core/auth/scopes.ts";
import type { GraphIndex, ScopeFamily } from "../src/core/index/graph-index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How many scopes the shortlist carries.
 *
 * Sized by the ceiling rather than by the shape of the data: 60 read scopes still double into a
 * read-write template of 120 if every one of them turns out to have a write counterpart, which
 * leaves 35 names of headroom under the ~155 cap. A longer shortlist would hand a person a list
 * that cannot fit before they have cut anything from it.
 */
export const SHORTLIST_SIZE = 60;

/** Depth 1 and 2 is the shallow bucket, which is where the permissions join actually covers. */
export const SHALLOW_DEPTH_LIMIT = 2;

export interface ScopeRanking {
  scope: string;
  /** 1-based position in this ranking, by shallow coverage first. */
  rank: number;
  /**
   * Delegated GET paths this scope unlocks: the `least` list where the reference marks one, the
   * `all` list where it does not. The fallback is not a rounding error — `least` is absent
   * precisely where Microsoft names no minimum, and dropping those paths would score a scope by
   * how thoroughly its resource happened to be documented.
   */
  totalPaths: number;
  /** Of `totalPaths`, the ones at one or two literal segments. */
  shallowPaths: number;
  /** Of `totalPaths`, the ones at three or more. */
  deepPaths: number;
  /** Paths where the reference explicitly marks this scope least privileged. */
  leastPrivilegedPaths: number;
  /** Paths whose `all` list names this scope, whether or not it is the minimum. */
  allPaths: number;
  /** Of `allPaths`, the ones at one or two literal segments. */
  allShallowPaths: number;
}

export interface ScoredPopulation {
  /** Delegated GET paths the index carries scopes for, which is everything scored. */
  paths: number;
  shallowPaths: number;
  /** Read scopes the index mentions anywhere, in either family and under any method. */
  readScopesMentioned: number;
}

/**
 * Path depth as literal segments, which is what `docs/research/2026-09-16-permissions-join.md`
 * counts. `/users` and `/users/{id}` are both depth 1: an id is not a level of nesting, it is
 * the same resource addressed singly, and counting it would file every item read one bucket
 * deeper than the collection it belongs to.
 */
export function literalPathDepth(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0 && !segment.startsWith("{")).length;
}

/** `least` where the reference marks one, `all` where it does not. */
function unlockingScopes(family: ScopeFamily): string[] {
  return family.least ?? family.all;
}

/**
 * The derived write counterpart of a read scope, the way `scopes.ts` derives one: swap the
 * action token for `ReadWrite`. Whether the index holds that name is a separate question, and
 * the ceiling arithmetic asks it so the write-up can print today's cost beside the worst case.
 */
function derivedWriteCounterpart(scope: string): string {
  const segments = scope.split(".");
  segments[1] = "ReadWrite";
  return segments.join(".");
}

type Tally = Omit<ScopeRanking, "rank">;

/**
 * Order by shallow coverage first, because ranking on totals ranks the tail: six segments and
 * deeper is 1,956 of the 6,558 real GET reads and 1.1% of the ones the index can name a scope
 * for. A scope that wins on totals alone won it somewhere nobody calls.
 */
function byShallowCoverage(a: Tally, b: Tally): number {
  return (
    b.shallowPaths - a.shallowPaths ||
    b.totalPaths - a.totalPaths ||
    b.allShallowPaths - a.allShallowPaths ||
    b.allPaths - a.allPaths ||
    a.scope.localeCompare(b.scope)
  );
}

/**
 * Score every read scope the index reaches against delegated GET paths.
 *
 * Delegated only, because the read template is a delegated consent request; application
 * permissions are a different ceiling and a different flow, so counting them would rank a scope
 * by a surface this template can never ask for. GET only for the mirror reason: a scope's write
 * paths are not what a read connection is buying.
 */
export function rankReadScopes(index: GraphIndex): ScopeRanking[] {
  const tallies = new Map<string, Tally>();

  const tallyFor = (scope: string): Tally => {
    let tally = tallies.get(scope);
    if (!tally) {
      tallies.set(scope, (tally = {
        scope,
        totalPaths: 0,
        shallowPaths: 0,
        deepPaths: 0,
        leastPrivilegedPaths: 0,
        allPaths: 0,
        allShallowPaths: 0,
      }));
    }
    return tally;
  };

  for (const [path, entry] of Object.entries(index.paths)) {
    for (const [method, scopeSet] of Object.entries(entry.scopes ?? {})) {
      const delegated = scopeSet.delegated;
      if (method.toLowerCase() !== "get" || !delegated) continue;

      const shallow = literalPathDepth(path) <= SHALLOW_DEPTH_LIMIT;

      for (const scope of unlockingScopes(delegated)) {
        if (classifyScope(scope) !== "read") continue;
        const tally = tallyFor(scope);
        tally.totalPaths += 1;
        if (shallow) tally.shallowPaths += 1;
        else tally.deepPaths += 1;
      }
      for (const scope of delegated.least ?? []) {
        if (classifyScope(scope) !== "read") continue;
        tallyFor(scope).leastPrivilegedPaths += 1;
      }
      for (const scope of delegated.all) {
        if (classifyScope(scope) !== "read") continue;
        const tally = tallyFor(scope);
        tally.allPaths += 1;
        if (shallow) tally.allShallowPaths += 1;
      }
    }
  }

  return [...tallies.values()]
    .sort(byShallowCoverage)
    .map((tally, position) => ({ ...tally, rank: position + 1 }));
}

/** The denominators the ranking has to be read against, so a count is never quoted bare. */
export function scoredPopulation(index: GraphIndex): ScoredPopulation {
  const mentioned = new Set<string>();
  let paths = 0;
  let shallowPaths = 0;

  for (const [path, entry] of Object.entries(index.paths)) {
    for (const [method, scopeSet] of Object.entries(entry.scopes ?? {})) {
      for (const name of scopeSet.delegated?.all ?? []) mentioned.add(name);
      for (const name of scopeSet.application?.all ?? []) mentioned.add(name);
      if (method.toLowerCase() !== "get" || !scopeSet.delegated) continue;
      paths += 1;
      if (literalPathDepth(path) <= SHALLOW_DEPTH_LIMIT) shallowPaths += 1;
    }
  }

  return {
    paths,
    shallowPaths,
    readScopesMentioned: [...mentioned].filter((name) => classifyScope(name) === "read").length,
  };
}

/** Every scope name the index mentions, which is what says whether a counterpart exists. */
function mentionedScopeNames(index: GraphIndex): Set<string> {
  const names = new Set<string>();
  for (const entry of Object.values(index.paths)) {
    for (const scopeSet of Object.values(entry.scopes ?? {})) {
      for (const name of scopeSet.delegated?.all ?? []) names.add(name);
      for (const name of scopeSet.application?.all ?? []) names.add(name);
    }
  }
  return names;
}

function shortlistRow(ranking: ScopeRanking): string {
  return `| ${ranking.rank} | \`${ranking.scope}\` | ${ranking.shallowPaths} | ${ranking.totalPaths} | ${
    ranking.deepPaths} | ${ranking.leastPrivilegedPaths} | ${ranking.allShallowPaths} | ${ranking.allPaths} |`;
}

const SHORTLIST_HEADER = [
  "| # | Scope | Shallow | Total | Deep | Marked least | All, shallow | All, total |",
  "|---:|---|---:|---:|---:|---:|---:|---:|",
];

export function renderMarkdown(
  rankings: ScopeRanking[],
  population: ScoredPopulation,
  counterpartsInIndex: number,
  builtAt: string,
): string {
  const shortlist = rankings.slice(0, SHORTLIST_SIZE);
  const shortlisted = new Set(shortlist.map(({ scope }) => scope));
  const doubled = shortlist.length * 2;
  const byName = new Map(rankings.map((ranking) => [ranking.scope, ranking]));
  const dropped = READ_TEMPLATE_SCOPES.filter((scope) => !shortlisted.has(scope));

  // A scope that is never the documented minimum scores zero on the sort key however much it
  // actually grants. Naming those separately is the whole reason the `all` columns exist.
  const sufficientButNeverMinimum = rankings
    .filter((ranking) => ranking.totalPaths === 0 && ranking.allShallowPaths > 0)
    .sort((a, b) => b.allShallowPaths - a.allShallowPaths || a.scope.localeCompare(b.scope))
    .slice(0, 15);

  const lines = [
    "# Ranking read scopes by index path coverage",
    "",
    `Measured for #49 against the shipped v1.0 index on ${builtAt}, by \`npm run rank:read-scopes\`.`,
    "This ranks; it does not choose. ADR-0012 records why the shipped read list has to be a cut",
    "rather than a confirmation, and the section on today's ten is the part that says what a",
    "mechanical cut would cost.",
    "",
    "## What was counted",
    "",
    "- **Delegated GET only.** The read template is a delegated consent request. Application",
    "  permissions are a different ceiling and a different flow, so an application surface cannot",
    "  earn a place in a template that can never ask for it.",
    "- **Least where marked, all where not.** A path's delegated `least` list is the documented",
    "  minimum; where the reference marks none, `least` is absent and `all` stands in. Scoring only",
    "  the marked paths would rank a scope by how thoroughly its resource happened to be",
    "  documented. `Total` is that count; `Marked least` is the strict subset the reference",
    "  actually marks.",
    "- **`All` is reported beside it**, because a scope that is never the minimum but is always",
    "  sufficient is a different proposition from one that is the documented minimum, and only the",
    "  two columns together tell them apart.",
    "- **Depth is literal segments**, so `/users` and `/users/{id}` are both depth 1. Shallow is one",
    `  or two segments, deep is ${SHALLOW_DEPTH_LIMIT + 1} or more. The join covers 62% of real GET reads at one or two`,
    "  segments and 0.7% at six, which is most of Graph and none of the traffic, so shallow",
    "  coverage is the sort key and total coverage is only the tiebreak.",
    "- **Read scopes only**, by `classifyScope` imported from `src/core/auth/scopes.ts`. An",
    "  unclassified name counts as a write and is absent here.",
    "",
    "## The population",
    "",
    "| | |",
    "|---|---:|",
    `| Delegated GET paths the index carries scopes for | ${population.paths.toLocaleString()} |`,
    `| …of those, at one or two literal segments | ${population.shallowPaths.toLocaleString()} |`,
    `| Read scopes the index mentions | ${population.readScopesMentioned.toLocaleString()} |`,
    `| …of those, reaching at least one delegated GET path | ${rankings.length.toLocaleString()} |`,
    `| …of those, reaching at least one shallow path | ${rankings.filter((r) => r.allShallowPaths > 0).length.toLocaleString()} |`,
    "",
    `${(population.readScopesMentioned - rankings.length).toLocaleString()} read scopes reach no delegated GET path in the index at all. That is not a claim that`,
    "they grant nothing. The permissions join reaches 30% of paths and an absent entry means the",
    "index does not know, so what this says is only that the ranking has nothing to say about them.",
    "",
    `## The shortlist: top ${SHORTLIST_SIZE} by shallow-path coverage`,
    "",
    ...SHORTLIST_HEADER,
    ...shortlist.map(shortlistRow),
    "",
    "## Today's ten shipped read scopes",
    "",
    "| Scope | Placement | Shallow | Total | Marked least | All, shallow | All, total |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...READ_TEMPLATE_SCOPES.map((scope) => {
      const ranking = byName.get(scope);
      const placement = ranking ? `${ranking.rank} of ${rankings.length}` : "unranked";
      return `| \`${scope}\` | ${placement} | ${ranking?.shallowPaths ?? 0} | ${ranking?.totalPaths ?? 0} | ${
        ranking?.leastPrivilegedPaths ?? 0} | ${ranking?.allShallowPaths ?? 0} | ${ranking?.allPaths ?? 0} |`;
    }),
    "",
    ...(dropped.length === 0
      ? [
        `The mechanical ranking keeps all ten inside its top ${SHORTLIST_SIZE}. That is a weaker endorsement`,
        "than it looks: sitting inside the shortlist is not the same as sitting near the top of it,",
        "and a scope can place in the fifties on coverage while being the one a person needs every",
        "week. What matters for the pick is the surface each scope reaches, not where it sorted.",
      ]
      : [
        `**The ranking would drop ${dropped.length} of the ten we ship today**: ${dropped.map((scope) => `\`${scope}\``).join(", ")}.`,
        "This is exactly the failure #49 names — ranking alone drops scopes used weekly. A scope",
        "earns its place by what an assessment reads, and the index can only score what Microsoft's",
        "reference documented.",
      ]),
    "",
    "## Sufficient everywhere, the documented minimum nowhere",
    "",
    "These read scopes unlock nothing under the sort key, because every shallow path that names",
    "them also names something narrower as its minimum. They score zero and sort last, and a",
    "ranking read without this section would look like it had dismissed them.",
    "",
    "| Scope | All, shallow | All, total |",
    "|---|---:|---:|",
    ...sufficientButNeverMinimum.map((ranking) =>
      `| \`${ranking.scope}\` | ${ranking.allShallowPaths} | ${ranking.allPaths} |`),
    "",
    "## The ceiling arithmetic",
    "",
    `Entra caps a delegated consent request at about ${DELEGATED_CONSENT_CEILING} permissions (ADR-0012).`,
    "",
    "| | Scopes | Against the ceiling |",
    "|---|---:|---|",
    `| The shortlist, as a read template | ${shortlist.length} | ${DELEGATED_CONSENT_CEILING - shortlist.length} names of headroom |`,
    `| The shortlist doubled, worst-case read-write | ${doubled} | ${
      doubled <= DELEGATED_CONSENT_CEILING
        ? `${DELEGATED_CONSENT_CEILING - doubled} names of headroom`
        : `${doubled - DELEGATED_CONSENT_CEILING} names over`} |`,
    `| The shortlist plus only the counterparts the index holds today | ${shortlist.length + counterpartsInIndex} | ${
      DELEGATED_CONSENT_CEILING - shortlist.length - counterpartsInIndex} names of headroom |`,
    `| Today's shipped read template | ${READ_TEMPLATE_SCOPES.length} | ${
      DELEGATED_CONSENT_CEILING - READ_TEMPLATE_SCOPES.length} names of headroom |`,
    "",
    "The doubled figure is the worst case on purpose. It assumes every shortlisted read scope has",
    "a `ReadWrite` counterpart worth asking for, which is not true today: `AuditLog` has none",
    "because Graph consumers cannot write append-only records, and `scopes.ts` already filters the",
    `derivation against the index, which holds ${counterpartsInIndex} of the ${shortlist.length}. A list that fits only while that`,
    "derivation stays partial is a list that breaks the first time Microsoft publishes a",
    "counterpart, so the worst case is the number a pick has to clear.",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function stdoutLines(rankings: ScopeRanking[], population: ScoredPopulation): string[] {
  const shortlist = rankings.slice(0, SHORTLIST_SIZE);
  const shortlisted = new Set(shortlist.map(({ scope }) => scope));
  const width = Math.max(...rankings.map(({ scope }) => scope.length));

  return [
    `Scored ${population.paths.toLocaleString()} delegated GET paths (${population.shallowPaths.toLocaleString()} shallow), reached by ${
      rankings.length} of the index's ${population.readScopesMentioned} read scopes.`,
    "",
    `  ${"#".padStart(3)}  ${"scope".padEnd(width)}  shallow  total   deep  least    all`,
    ...shortlist.map((ranking) =>
      `  ${String(ranking.rank).padStart(3)}  ${ranking.scope.padEnd(width)}  ${
        String(ranking.shallowPaths).padStart(7)}  ${String(ranking.totalPaths).padStart(5)}  ${
        String(ranking.deepPaths).padStart(5)}  ${String(ranking.leastPrivilegedPaths).padStart(5)}  ${
        String(ranking.allPaths).padStart(5)}`),
    "",
    ...READ_TEMPLATE_SCOPES.map((scope) => {
      const ranking = rankings.find((entry) => entry.scope === scope);
      const placement = ranking ? `rank ${ranking.rank} of ${rankings.length}` : "unranked";
      return `  shipped  ${scope.padEnd(width)}  ${placement}${shortlisted.has(scope) ? "" : "  — NOT in the shortlist"}`;
    }),
    "",
    `  shortlist ${shortlist.length}, doubled ${shortlist.length * 2}, ceiling about ${DELEGATED_CONSENT_CEILING}`,
  ];
}

async function run(): Promise<void> {
  const index = JSON.parse(await readFile(resolve(repositoryRoot, "data/graph-index.json"), "utf8")) as GraphIndex;
  const rankings = rankReadScopes(index);
  const population = scoredPopulation(index);
  const names = mentionedScopeNames(index);
  const counterpartsInIndex = rankings
    .slice(0, SHORTLIST_SIZE)
    .filter(({ scope }) => names.has(derivedWriteCounterpart(scope))).length;
  const builtAt = new Date().toISOString().slice(0, 10);

  await writeFile(
    resolve(repositoryRoot, "data/read-scope-ranking.json"),
    `${JSON.stringify({ builtAt, indexBuiltAt: index.builtAt, population, shortlistSize: SHORTLIST_SIZE, rankings }, null, 2)}\n`,
  );
  const writeUp = `docs/measurements/${builtAt}-read-scope-ranking.md`;
  await writeFile(resolve(repositoryRoot, writeUp), renderMarkdown(rankings, population, counterpartsInIndex, builtAt));

  for (const line of stdoutLines(rankings, population)) console.log(line);
  console.log(`\n  wrote data/read-scope-ranking.json and ${writeUp}`);
}

// Only run when invoked as a command, for the reason `build-index/build.ts` gives: importing
// this module to reach an export must never rewrite the files a test is asserting on.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
