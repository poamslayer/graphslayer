import { describe, it, expect, vi } from "vitest";
import { removeConnection } from "../../../src/core/connections/remove.js";
import { appOnlySecretAccount, MemorySecretStore } from "../../../src/core/secrets/keychain.js";
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

/** An app-only connection: no username, because the principal is the application. */
const appConn: Connection = {
  alias: "contoso-app",
  tenantId: "00000000-0000-0000-0000-000000000003",
  tenantName: "Contoso",
  kind: "app",
  mode: "write",
  clientId: "app-client-id",
  scopes: ["User.Read.All"],
  addedAt: "2026-09-16T00:00:00.000Z",
};

/** An agent connection: a person signed in, an agent identity acting for them. ADR-0015. */
const agentConn: Connection = {
  alias: "contoso-agent",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantName: "Contoso",
  kind: "agent",
  mode: "read",
  clientId: "x",
  homeAccountId: "home-1",
  username: "admin@contoso.com",
  agentId: "agent-app-id",
  blueprintId: "blueprint-app-id",
  scopes: ["Directory.Read.All"],
  addedAt: "2026-10-01T00:00:00.000Z",
};

function deps(initial: Connection[] = [conn]) {
  const list = initial.slice();
  const store = {
    list: async () => list.slice(),
    resolve: async (k: string) => list.find((c) => c.alias === k || c.tenantId === k),
    remove: vi.fn(async (alias: string) => {
      const i = list.findIndex((c) => c.alias === alias);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    }),
  };
  const auth = { removeAccount: vi.fn(async () => {}) };
  const secrets = new MemorySecretStore();
  vi.spyOn(secrets, "delete");
  return { store, auth, secrets };
}

describe("removeConnection", () => {
  it("removes a connection and its cached account", async () => {
    const d = deps();
    expect(await removeConnection(d, "contoso")).toBe(true);
    expect(d.auth.removeAccount).toHaveBeenCalled();
    expect(await removeConnection(d, "contoso")).toBe(false);
  });

  it("removes a connection named by its tenant id", async () => {
    const d = deps();
    expect(await removeConnection(d, conn.tenantId)).toBe(true);
    expect(await d.store.list()).toEqual([]);
  });

  it("removes an app-only connection's keychain credential along with its record", async () => {
    const d = deps([appConn]);
    await d.secrets.set(appOnlySecretAccount(appConn.tenantId, appConn.clientId), "s3cret");

    expect(await removeConnection(d, "contoso-app")).toBe(true);
    expect(d.secrets.delete).toHaveBeenCalledWith(appOnlySecretAccount(appConn.tenantId, appConn.clientId));
    expect(await d.secrets.get(appOnlySecretAccount(appConn.tenantId, appConn.clientId))).toBeUndefined();
  });

  it("leaves the secret store alone when the connection is delegated", async () => {
    const d = deps();
    await removeConnection(d, "contoso");
    expect(d.secrets.delete).not.toHaveBeenCalled();
  });

  it("still removes an app-only connection whose keychain entry is already gone", async () => {
    const d = deps([appConn]);
    expect(await removeConnection(d, "contoso-app")).toBe(true);
    expect(d.secrets.delete).toHaveBeenCalled();
    expect(await d.store.list()).toEqual([]);
  });

  it("removes the record even when clearing the keychain entry throws", async () => {
    const d = deps([appConn]);
    (d.secrets.delete as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("keychain locked"));
    expect(await removeConnection(d, "contoso-app")).toBe(true);
  });

  it("clears an agent connection's blueprint credential from the keychain", async () => {
    const d = deps([agentConn]);
    const account = appOnlySecretAccount(agentConn.tenantId, "blueprint-app-id");
    await d.secrets.set(account, "s3cret");

    await removeConnection(d, "contoso-agent");

    expect(await d.secrets.get(account)).toBeUndefined();
  });

  it("keeps the cached sign-in while another connection still uses the same account", async () => {
    const d = deps([{ ...conn, homeAccountId: "home-1" }, agentConn]);

    await removeConnection(d, "contoso-agent");
    expect(d.auth.removeAccount).not.toHaveBeenCalled();

    await removeConnection(d, "contoso");
    expect(d.auth.removeAccount).toHaveBeenCalledTimes(1);
  });
});
