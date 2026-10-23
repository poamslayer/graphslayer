import type { MsalAuth } from "../auth/msal.js";
import { appOnlySecretAccount, type SecretStore } from "../secrets/keychain.js";
import type { Connection } from "../types.js";
import type { ConnectionStore } from "./store.js";

export interface RemoveConnectionDeps {
  store: Pick<ConnectionStore, "list" | "resolve" | "remove">;
  auth: Pick<MsalAuth, "removeAccount">;
  /** Cleared alongside an app-only or agent connection, so removing one leaves no credential behind. */
  secrets: Pick<SecretStore, "delete">;
}

/**
 * The keychain entry a connection's credential lives under, if it has one. App-only keeps it under
 * its own client id, an agent connection under its blueprint's, and a delegated one has none.
 */
function credentialAccount(connection: Connection): string | undefined {
  if (connection.kind === "app") return appOnlySecretAccount(connection.tenantId, connection.clientId);
  if (connection.kind === "agent" && connection.blueprintId) return appOnlySecretAccount(connection.tenantId, connection.blueprintId);
  return undefined;
}

/** Removes a stored connection, its cached sign-in and its credential. Returns false if there was none. */
export async function removeConnection(deps: RemoveConnectionDeps, alias: string): Promise<boolean> {
  const existing = await deps.store.resolve(alias);
  if (!existing) return false;
  // The cached sign-in belongs to the account, not to this record, and an agent connection
  // always shares it with the person's delegated connections. Removing it while another
  // connection still uses it would sign that connection out as well.
  if (existing.homeAccountId) {
    const shared = (await deps.store.list()).some((c) => c.alias !== existing.alias && c.homeAccountId === existing.homeAccountId);
    if (!shared) await deps.auth.removeAccount(existing);
  } else {
    await deps.auth.removeAccount(existing);
  }
  const account = credentialAccount(existing);
  if (account) {
    // Tolerant on purpose. An entry a person already deleted by hand must not be able to
    // strand the connection record, which would leave an unusable connection nothing removes.
    await deps.secrets.delete(account).catch(() => false);
  }
  return deps.store.remove(existing.alias);
}

/**
 * Keeps only the sign-in just stored. An install is signed in to one tenant, so connecting again
 * replaces the old sign-in instead of adding a second. The new one is stored first, so a cached
 * account the two share is kept. ADR-0021.
 */
export async function keepOnlySignIn(deps: RemoveConnectionDeps, alias: string): Promise<string[]> {
  const others = (await deps.store.list()).filter((c) => c.alias !== alias);
  for (const c of others) await removeConnection(deps, c.alias);
  return others.map((c) => c.alias);
}

/** Removes every sign-in this install holds. Returns the aliases removed. */
export async function removeAllSignIns(deps: RemoveConnectionDeps): Promise<string[]> {
  const all = await deps.store.list();
  for (const c of all) await removeConnection(deps, c.alias);
  return all.map((c) => c.alias);
}
