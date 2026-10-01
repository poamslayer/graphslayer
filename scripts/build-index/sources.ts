/**
 * Microsoft's published metadata, cached on the maintainer's machine.
 *
 * The OpenAPI ships only as YAML and Node cannot read it. `js-yaml` exhausts an 8 GB heap on
 * the 44 MB v1.0 document, because a JavaScript-level parser allocates far too much per node.
 * The same document converted once with libyaml and read with `JSON.parse` costs 83 ms and
 * 259 MB. So the build converts first, with python3's C loader, and never parses YAML itself.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

export interface Source {
  name: string;
  url: string;
}

export const SOURCES: Source[] = [
  {
    name: "openapi-v1.0.yaml",
    url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
  },
  {
    name: "openapi-beta.yaml",
    url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/beta/openapi.yaml",
  },
  {
    name: "csdl-v1.0.xml",
    url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/clean_v10_metadata/cleanMetadata.xml",
  },
  {
    name: "csdl-beta.xml",
    url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/clean_beta_metadata/cleanMetadata.xml",
  },
  {
    name: "csdl-usgov-v1.0.xml",
    url: "https://graph.microsoft.us/v1.0/$metadata",
  },
  {
    name: "csdl-usgov-beta.xml",
    url: "https://graph.microsoft.us/beta/$metadata",
  },
  {
    name: "permissions.json",
    url: "https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-devx-content/master/permissions/new/permissions.json",
  },
];

/**
 * The sources still to download, given what the cache holds and how big each cached file is.
 *
 * `refresh` takes every source again. A release built from a cache filled months ago would
 * ship an index of a Graph that has moved, and nothing in the file would say so.
 */
export function sourcesToFetch(sources: Source[], present: Map<string, number>, options: { refresh?: boolean } = {}): Source[] {
  return options.refresh ? [...sources] : sources.filter((source) => !present.get(source.name));
}

/** Whether this machine can do the YAML conversion the build depends on. */
export function hasYamlConverter(): boolean {
  const probe = spawnSync("python3", ["-c", "import yaml; yaml.CSafeLoader"], { stdio: "ignore" });
  return probe.status === 0;
}

/** Convert a YAML document to JSON with libyaml's C loader. */
export function convertYamlToJson(yamlPath: string, jsonPath: string): void {
  const script = [
    "import sys, json, yaml",
    "doc = yaml.load(open(sys.argv[1]), Loader=yaml.CSafeLoader)",
    "json.dump(doc, open(sys.argv[2], 'w'), separators=(',', ':'))",
  ].join("\n");

  // Convert to a temporary file and rename, so a conversion that dies half way through
  // cannot leave a truncated JSON behind that the next run reads as a good cache entry.
  const partial = `${jsonPath}.part`;
  const result = spawnSync("python3", ["-c", script, yamlPath, partial], { stdio: "inherit" });
  if (!result.error && result.status === 0) {
    renameSync(partial, jsonPath);
    return;
  }
  rmSync(partial, { force: true });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Converting ${yamlPath} to JSON failed. The build needs python3 with PyYAML built against libyaml `
        + `(python3 -c "import yaml; yaml.CSafeLoader"), because Node cannot parse Graph's OpenAPI.`,
    );
  }
}

export type Download = (source: Source, destination: string) => Promise<void>;

/** Stream a source to a temporary file, then rename, so a failed download never looks cached. */
export const fetchSource: Download = async (source, destination) => {
  const response = await fetch(source.url);
  if (!response.ok || !response.body) throw new Error(`${source.url}: ${response.status}`);

  const partial = `${destination}.part`;
  // Node's fetch body is async-iterable, which streams without the DOM/undici type clash.
  await pipeline(Readable.from(response.body as AsyncIterable<Uint8Array>), createWriteStream(partial));
  await rename(partial, destination);
};

async function cachedSizes(directory: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const name of await readdir(directory)) {
    sizes.set(name, (await stat(join(directory, name))).size);
  }
  return sizes;
}

export interface EnsureOptions {
  sources?: Source[];
  download?: Download;
  converterAvailable?: () => boolean;
  /** Re-download every source and reconvert, rather than reusing what the cache holds. */
  refresh?: boolean;
  log?: (message: string) => void;
}

function jsonPathFor(yamlPath: string): string {
  return yamlPath.replace(/\.yaml$/, ".json");
}

async function yamlSourcesNeedingConversion(directory: string, sources: Source[], refresh: boolean): Promise<Source[]> {
  const yamlSources = sources.filter((candidate) => candidate.name.endsWith(".yaml"));
  if (refresh) return yamlSources;

  const pending: Source[] = [];
  for (const source of yamlSources) {
    const converted = await stat(jsonPathFor(join(directory, source.name))).catch(() => null);
    if (!converted?.size) pending.push(source);
  }
  return pending;
}

/**
 * Put every source in the cache directory, downloading what is missing and converting each
 * YAML document to the JSON the build reads. Anything already cached is left alone, so a
 * rebuild costs nothing and a maintainer can drop a file in by hand.
 */
export async function ensureSources(directory: string, options: EnsureOptions = {}): Promise<void> {
  const { sources = SOURCES, download = fetchSource, converterAvailable = hasYamlConverter, refresh = false, log = () => {} } = options;
  await mkdir(directory, { recursive: true });

  // Check for the converter before downloading, so a machine without it hears what to install
  // rather than spending 130 MB on a build that cannot finish.
  const toConvert = await yamlSourcesNeedingConversion(directory, sources, refresh);
  if (toConvert.length > 0 && !converterAvailable()) {
    throw new Error(
      "The index build needs python3 with PyYAML built against libyaml. Check it with "
        + '`python3 -c "import yaml; yaml.CSafeLoader"`. Node cannot parse Graph\'s OpenAPI: js-yaml '
        + "exhausts an 8 GB heap on the 44 MB v1.0 document.",
    );
  }

  for (const source of sourcesToFetch(sources, await cachedSizes(directory), { refresh })) {
    log(`downloading ${source.name}`);
    await download(source, join(directory, source.name));
  }

  for (const source of toConvert) {
    const yamlPath = join(directory, source.name);
    log(`converting ${source.name} to JSON`);
    convertYamlToJson(yamlPath, jsonPathFor(yamlPath));
  }
}
