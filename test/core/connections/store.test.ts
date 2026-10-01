import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloudOf, ConnectionStore, modeOf } from "../../../src/core/connections/store.js";
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

  it("treats a connection stored before modes as read", async () => {
    writeFileSync(file, `{
  "version": 1,
  "connections": [
    {
      "alias": "contoso",
      "tenantId": "00000000-0000-0000-0000-000000000001",
      "kind": "delegated",
      "clientId": "14d82eec-204b-4c2f-b7e8-296a70dab67e",
      "scopes": ["User.Read"],
      "addedAt": "2026-09-15T00:00:00.000Z"
    }
  ]
}`);

    const [connection] = await new ConnectionStore(file).list();
    expect(modeOf(connection)).toBe("read");
  });

  it("round-trips a connection stored before clouds as commercial", async () => {
    writeFileSync(file, `{
  "version": 1,
  "connections": [
    {
      "alias": "contoso",
      "tenantId": "00000000-0000-0000-0000-000000000001",
      "kind": "delegated",
      "clientId": "14d82eec-204b-4c2f-b7e8-296a70dab67e",
      "scopes": ["User.Read"],
      "addedAt": "2026-09-15T00:00:00.000Z"
    }
  ]
}`);
    const store = new ConnectionStore(file);

    const [legacy] = await store.list();
    expect(cloudOf(legacy)).toBe("commercial");
    await store.upsert(legacy);
    const [roundTripped] = await new ConnectionStore(file).list();
    expect(cloudOf(roundTripped)).toBe("commercial");
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

  it("round-trips and removes a write connection", async () => {
    const store = new ConnectionStore(file);
    await store.upsert({ ...sample("contoso", "00000000-0000-0000-0000-000000000001"), mode: "write" });

    expect(await store.list()).toEqual([expect.objectContaining({ mode: "write" })]);
    expect(await store.remove("contoso")).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("round-trips a read connection", async () => {
    const store = new ConnectionStore(file);
    await store.upsert({ ...sample("contoso", "00000000-0000-0000-0000-000000000001"), mode: "read" });

    expect(await store.list()).toEqual([expect.objectContaining({ mode: "read" })]);
  });

  it("removes by alias and reports whether anything was removed", async () => {
    const store = new ConnectionStore(file);
    await store.upsert(sample("contoso", "00000000-0000-0000-0000-000000000001"));
    expect(await store.remove("contoso")).toBe(true);
    expect(await store.remove("contoso")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
