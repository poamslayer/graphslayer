import { Entry } from "@napi-rs/keyring";

/**
 * Every secret this server writes lives under one service name, so a person can find them all
 * in one place and delete them without guessing. `src/core/auth/msal.ts` already hands MSAL's
 * own persistence this same service name with the account `msal-token-cache`, so the account
 * name is the only thing keeping our entries from colliding with the token cache.
 */
export const KEYCHAIN_SERVICE = "graphslayer";

export interface SecretStore {
  set(account: string, secret: string): Promise<void>;
  /** Undefined when nothing is stored, which is not an error. */
  get(account: string): Promise<string | undefined>;
  /** True when something was removed. */
  delete(account: string): Promise<boolean>;
}

type KeyringEntry = Pick<Entry, "setPassword" | "getPassword" | "deletePassword">;
type EntryFactory = (service: string, account: string) => KeyringEntry;

/**
 * The methods stay asynchronous even though Entry is synchronous so a future
 * I/O-backed implementation will not force every caller to change.
 */
export class KeyringSecretStore implements SecretStore {
  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    // This narrow seam exists so the cross-platform missing-entry contract can be tested independently of this host.
    private readonly entryFactory: EntryFactory = (service, account) => new Entry(service, account),
  ) {}

  async set(account: string, secret: string): Promise<void> {
    this.entryFactory(this.service, account).setPassword(secret);
  }

  async get(account: string): Promise<string | undefined> {
    try {
      return this.entryFactory(this.service, account).getPassword() ?? undefined;
    } catch {
      // Absence is normal, including on backends that report a missing entry by throwing instead of returning null.
      return undefined;
    }
  }

  async delete(account: string): Promise<boolean> {
    return this.entryFactory(this.service, account).deletePassword();
  }
}

/** The store tests and callers of #47 use, so no test has to touch a developer's real keychain. */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
  }

  async get(account: string): Promise<string | undefined> {
    return this.secrets.get(account);
  }

  async delete(account: string): Promise<boolean> {
    return this.secrets.delete(account);
  }
}

/**
 * The keychain account an app-only connection's credential lives under.
 *
 * It is derived rather than stored so it survives a restart without a second record to keep in
 * step, and it carries both the tenant and the client id because one registration can be added
 * for several tenants and one tenant can hold several registrations; either half alone would
 * let two connections overwrite each other's credential. Both the sign-in that writes the
 * credential and the removal that clears it call this, so the two can never drift apart.
 */
export function appOnlySecretAccount(tenantId: string, clientId: string): string {
  return `app-only:${tenantId}:${clientId}`;
}
