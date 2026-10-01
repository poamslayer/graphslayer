import type { Cloud } from "./config.js";

/** An agent connection is delegated too, but Graph sees an agent identity acting for the person. ADR-0015. */
export type ConnectionKind = "delegated" | "app" | "agent";
export type ConnectionMode = "read" | "write";

export interface Connection {
  alias: string;
  tenantId: string;
  tenantName?: string;
  /** Absent only on records written before clouds were stored; `cloudOf` resolves that legacy shape. */
  cloud?: Cloud;
  kind: ConnectionKind;
  mode?: ConnectionMode;
  clientId: string;
  homeAccountId?: string;
  username?: string;
  /**
   * The certificate an app-only connection authenticates with, when it uses one rather than a
   * client secret. Only the path and the public thumbprint are here. The password that decrypts
   * the private key is never written to this record, and neither is a client secret or the key
   * itself: this file is plain JSON on disk, and the credential belongs in the OS keychain under
   * `appOnlySecretAccount(tenantId, clientId)`. ADR-0007.
   */
  certPath?: string;
  certThumbprint?: string;
  /**
   * An agent connection's two Entra Agent ID appIds. The blueprint holds the credential (the
   * certificate above, or a secret in the keychain under `appOnlySecretAccount(tenantId,
   * blueprintId)`), and the agent identity is the client Graph sees. ADR-0015.
   */
  agentId?: string;
  blueprintId?: string;
  /** Granted scopes: what the token carries, which can be wider than what was requested. */
  scopes: string[];
  /**
   * What the delegated sign-in asked for, which is what the consent screen showed. Kept apart from
   * `scopes` because the shared client id can already hold tenant-wide consent, and the token then
   * carries both. Absent on app-only connections, which request `.default`, and on records written
   * before it was stored. #66.
   */
  requestedScopes?: string[];
  addedAt: string;
}

export type ApiVersion = "v1.0" | "beta";

export interface QueryOpts {
  select?: string[];
  filter?: string;
  expand?: string[];
  orderby?: string;
  search?: string;
  top?: number;
  beta?: boolean;
  cursor?: string;
}

export interface Page {
  items: unknown[];
  nextCursor?: string;
}

export interface GraphCallRecord {
  method: string;
  path: string;
  status: number;
  ms: number;
  apiVersion: ApiVersion;
}
