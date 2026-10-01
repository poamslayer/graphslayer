import type { Connection } from "../types.js";

export interface TokenProvider {
  /** Returns a bearer token for Microsoft Graph for this connection. */
  getGraphToken(connection: Connection): Promise<string>;
  /**
   * Asks Entra for a new token, skipping the cache, and returns it only when it carries scopes the
   * connection did not record. Undefined means a retry would get the same answer. #73.
   */
  refreshGraphToken?(connection: Connection): Promise<string | undefined>;
}
