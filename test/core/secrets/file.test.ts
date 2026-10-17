import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, stat, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSecretStore } from "../../../src/core/secrets/file.js";

describe("FileSecretStore (#10)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), "gs-secrets-")), "home");
    file = path.join(dir, "secrets.json");
  });

  it("returns undefined before anything is stored, without creating the file", async () => {
    const store = new FileSecretStore(file);
    expect(await store.get("app-only:t:c")).toBeUndefined();
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it("stores, reads back and deletes, keeping other accounts", async () => {
    const store = new FileSecretStore(file);
    await store.set("a", "one");
    await store.set("b", "two");
    expect(await new FileSecretStore(file).get("a")).toBe("one");
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(await store.get("b")).toBe("two");
  });

  it("writes the file 0600 in a 0700 directory, and tightens a loosened file on the next write", async () => {
    const store = new FileSecretStore(file);
    await store.set("a", "one");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    await chmod(file, 0o644);
    await store.set("b", "two");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    const store = new FileSecretStore(file);
    await store.set("a", "one");
    expect(await readdir(dir)).toEqual(["secrets.json"]);
  });

  it("throws on a corrupt file rather than treating it as empty and overwriting it", async () => {
    const store = new FileSecretStore(file);
    await store.set("a", "one");
    await writeFile(file, "{not json");
    await expect(store.get("a")).rejects.toThrow();
    await expect(store.set("b", "two")).rejects.toThrow();
  });
});
