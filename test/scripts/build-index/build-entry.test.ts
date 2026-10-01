import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The index build writes tracked files and can download 130 MB. Importing the module must
 * never set that off: a test that reaches for a constant would otherwise rebuild the very
 * artifact it is about to assert on, and `npm test` would leave the working tree dirty.
 */
describe("importing the build module", () => {
  it("does not run the build", async () => {
    const report = resolve(process.cwd(), "data/graph-index.report.json");
    const before = { mtimeMs: statSync(report).mtimeMs, text: readFileSync(report, "utf8") };

    await import("../../../scripts/build-index/build.ts");

    expect(readFileSync(report, "utf8")).toBe(before.text);
    expect(statSync(report).mtimeMs).toBe(before.mtimeMs);
  });
});
