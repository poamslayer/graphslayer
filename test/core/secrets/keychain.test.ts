import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appOnlySecretAccount, KeyringSecretStore, MemorySecretStore } from "../../../src/core/secrets/keychain.js";

describe("MemorySecretStore", () => {
  it("stores, reads, and deletes a secret", async () => {
    const store = new MemorySecretStore();

    await store.set("app-only-contoso", "hunter2");

    expect(await store.get("app-only-contoso")).toBe("hunter2");
    expect(await store.delete("app-only-contoso")).toBe(true);
    expect(await store.get("app-only-contoso")).toBeUndefined();
  });

  it("returns undefined for an unknown account", async () => {
    const store = new MemorySecretStore();

    expect(await store.get("unknown")).toBeUndefined();
  });

  it("returns false when deleting an unknown account", async () => {
    const store = new MemorySecretStore();

    expect(await store.delete("unknown")).toBe(false);
  });

  it("overwrites a secret for the same account", async () => {
    const store = new MemorySecretStore();
    await store.set("app-only-contoso", "first");

    await store.set("app-only-contoso", "second");

    expect(await store.get("app-only-contoso")).toBe("second");
  });
});

describe("KeyringSecretStore", () => {
  it("stores, reads, and deletes a secret in the operating system keychain", async ({ skip }) => {
    const store = new KeyringSecretStore();
    const account = `test-${process.pid}-${randomUUID()}`;
    let stored = false;

    try {
      try {
        await store.set(account, "throwaway-secret");
        stored = true;
      } catch (error) {
        if (
          process.platform === "darwin" &&
          error instanceof Error &&
          error.message.includes("Unable to obtain authorization")
        ) {
          skip("macOS denied keychain authorization to this headless test runner");
        }
        throw error;
      }

      expect(await store.get(account)).toBe("throwaway-secret");
      expect(await store.delete(account)).toBe(true);
      stored = false;
      expect(await store.get(account)).toBeUndefined();
    } finally {
      if (stored) await store.delete(account);
    }
  });

  it("returns undefined when the native backend reports absence by throwing", async () => {
    let nativeGetWasCalled = false;
    const store = new KeyringSecretStore("test-service", () => ({
      setPassword: () => {},
      getPassword: () => {
        nativeGetWasCalled = true;
        throw new Error("missing entry");
      },
      deletePassword: () => false,
    }));

    await expect(store.get("unknown")).resolves.toBeUndefined();
    expect(nativeGetWasCalled).toBe(true);
  });
});

describe("appOnlySecretAccount", () => {
  it("names one credential per registration per tenant", () => {
    expect(appOnlySecretAccount("t-1", "c-1")).toBe("app-only:t-1:c-1");
    // Neither half alone is enough: one registration can serve several tenants, and one tenant
    // can hold several registrations. Sharing an account name would overwrite a credential.
    expect(appOnlySecretAccount("t-1", "c-1")).not.toBe(appOnlySecretAccount("t-2", "c-1"));
    expect(appOnlySecretAccount("t-1", "c-1")).not.toBe(appOnlySecretAccount("t-1", "c-2"));
  });

  it("is stable, so a restart finds the same entry", () => {
    expect(appOnlySecretAccount("t-1", "c-1")).toBe(appOnlySecretAccount("t-1", "c-1"));
  });
});
