import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { resolveCloud, type Cloud } from "../config.js";
import type { GraphIndex } from "./graph-index.js";

export type LoadedIndex = {
  index: GraphIndex;
  /**
   * The source the index was parsed from. An index run places the index into the isolate as an
   * object literal rather than parsing it there — measured 63 MB of budget as a literal against
   * 57 MB through `JSON.parse`, because escaping the JSON into a string inflates the source about
   * 1.16x. That needs the text, not the value, so the loader keeps both.
   */
  text: string;
  loadMs: number;
  bytes: number;
};

const DEFAULT_INDEX_FILE = fileURLToPath(new URL("../../../data/graph-index.json", import.meta.url));
const DEFAULT_REMOVALS_FILES: Record<GraphIndex["version"], string> = {
  "v1.0": fileURLToPath(new URL("../../../data/graph-index.usgov.removals.json", import.meta.url)),
  beta: fileURLToPath(new URL("../../../data/graph-index-beta.usgov.removals.json", import.meta.url)),
};

export async function loadGraphIndex(
  file = DEFAULT_INDEX_FILE,
  options: { cloud?: Cloud; removalsFile?: string } = {},
): Promise<LoadedIndex> {
  const started = performance.now();
  let text = await readFile(file, "utf8");
  let index = JSON.parse(text) as GraphIndex;

  if (options.cloud === "usgov-high") {
    const removals = new Set(JSON.parse(
      await readFile(options.removalsFile ?? DEFAULT_REMOVALS_FILES[index.version], "utf8"),
    ) as string[]);
    index = {
      ...index,
      paths: Object.fromEntries(Object.entries(index.paths).filter(([path]) => !removals.has(path))),
    };
    // An index run injects this source into the isolate as an object literal. Keeping the
    // commercial text here would put every removed path straight back into that second view.
    text = JSON.stringify(index);
  }

  return { index, text, loadMs: performance.now() - started, bytes: Buffer.byteLength(text) };
}

export type IndexLoader = (cloud?: Cloud) => Promise<LoadedIndex>;

export function createIndexLoader(
  file?: string,
  options: { removalsFile?: string } = {},
): IndexLoader {
  const loaded = new Map<Cloud, Promise<LoadedIndex>>();

  return (requestedCloud) => {
    const cloud = resolveCloud(requestedCloud);
    let result = loaded.get(cloud);
    if (!result) {
      const attempt = loadGraphIndex(file, { cloud, ...options });
      loaded.set(cloud, attempt);
      void attempt.catch(() => {
        if (loaded.get(cloud) === attempt) loaded.delete(cloud);
      });
      result = attempt;
    }
    return result;
  };
}
