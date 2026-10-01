import path from "node:path";

/** Microsoft Graph Command Line Tools. Listed by Microsoft Learn as a Microsoft tenant-owned application. */
export const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

export type Cloud = "commercial" | "usgov-high";

const CLOUD_ENDPOINTS: Record<Cloud, { graphOrigin: string; graphScopeDefault: string; authorityBase: string }> = {
  commercial: {
    graphOrigin: "https://graph.microsoft.com",
    graphScopeDefault: "https://graph.microsoft.com/.default",
    authorityBase: "https://login.microsoftonline.com",
  },
  "usgov-high": {
    graphOrigin: "https://graph.microsoft.us",
    graphScopeDefault: "https://graph.microsoft.us/.default",
    authorityBase: "https://login.microsoftonline.us",
  },
};

/**
 * The one place that decides what an absent cloud means. Connections written before clouds
 * existed have no field to read, and commercial was the only endpoint they could have used, so
 * defaulting here is the whole migration. ADR-0013.
 */
export function resolveCloud(cloud: Cloud | undefined): Cloud {
  return cloud ?? "commercial";
}

/** Keeping the deployments in one table makes a future DoD addition one entry. */
export function cloudEndpoints(cloud: Cloud | undefined) {
  return CLOUD_ENDPOINTS[resolveCloud(cloud)];
}

export interface Config {
  homeDir: string;
  connectionsFile: string;
  msalCacheFile: string;
  clientId: string;
  tokenCacheEnabled: boolean;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  const homeDir = env.GRAPHSLAYER_HOME ?? path.join(home, ".graphslayer");
  return {
    homeDir,
    connectionsFile: path.join(homeDir, "connections.json"),
    msalCacheFile: path.join(homeDir, "msal-cache.json"),
    clientId: env.GRAPHSLAYER_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    tokenCacheEnabled: env.GRAPHSLAYER_NO_TOKEN_CACHE !== "1",
  };
}
