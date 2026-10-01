/** Kept apart from server.ts so the Graph client can name the server without importing the tools. */
export const SERVER_NAME = "graphslayer";
export const SERVER_VERSION = "0.1.0";

/**
 * Sent on every Graph request. Microsoft Graph activity logs record the User-Agent, and on a
 * delegated connection the shared Graph CLI client id cannot tell this server's calls from Graph
 * PowerShell's, so this header is how a tenant finds them. ADR-0016.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
