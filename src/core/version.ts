import { createRequire } from "node:module";

/**
 * Read from package.json, so bumping the version for a release is the only edit. The path is
 * the same from src/core and from dist/core, and npm always ships package.json.
 */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** Kept apart from server.ts so the Graph client can name the server without importing the tools. */
export const SERVER_NAME = "graphslayer";
export const SERVER_VERSION = version;

/**
 * Sent on every Graph request. Microsoft Graph activity logs record the User-Agent, and on a
 * delegated connection the shared Graph CLI client id cannot tell this server's calls from Graph
 * PowerShell's, so this header is how a tenant finds them. ADR-0016.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
