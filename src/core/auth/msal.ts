import { createPrivateKey, X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { ConfidentialClientApplication, PublicClientApplication, type Configuration } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import open from "open";
import { cloudEndpoints, type Cloud, type Config } from "../config.js";
import { cloudOf } from "../connections/store.js";
import { appOnlySecretAccount, type SecretStore } from "../secrets/keychain.js";
import type { Connection, ConnectionMode } from "../types.js";
import { modeForTemplate, scopesForTemplate, SIGN_IN_SCOPES, type ScopeTemplate } from "./scopes.js";
import type { TokenProvider } from "./token-provider.js";


export interface SignInResult {
  connection: Connection;
}

export interface AppOnlySignInInput {
  tenantId: string;
  clientId: string;
  cloud?: Cloud;
  /** Explicit, because an app-only connection gets no scope template to imply it. ADR-0012. */
  mode: ConnectionMode;
  /** The client secret, or the password that decrypts the private key when `certPath` is set. */
  credential: string;
  certPath?: string;
  alias?: string;
}

export interface AgentSignInInput {
  tenantId: string;
  /** The agent identity blueprint's appId. It holds the credential. */
  blueprintId: string;
  /** The agent identity's appId. Graph sees this client, acting for the person who signs in. */
  agentId: string;
  cloud?: Cloud;
  /** Explicit, as for app-only: no scope template implies it. */
  mode: ConnectionMode;
  /** The blueprint's client secret, or the password for the private key when `certPath` is set. */
  credential: string;
  certPath?: string;
  alias?: string;
}

export interface MsalAuth extends TokenProvider {
  signInDelegated(input: { alias?: string; tenantHint?: string; cloud?: Cloud; scopes?: string[]; template?: ScopeTemplate }): Promise<SignInResult>;
  signInAppOnly(input: AppOnlySignInInput): Promise<SignInResult>;
  signInAgent(input: AgentSignInInput): Promise<SignInResult>;
  removeAccount(connection: Connection): Promise<void>;
}

/** The subset of PublicClientApplication this module uses. Tests pass a fake. */
export interface PcaLike {
  acquireTokenInteractive(req: {
    scopes: string[];
    openBrowser: (url: string) => Promise<void>;
    successTemplate?: string;
    errorTemplate?: string;
  }): Promise<{ accessToken: string; account: { homeAccountId: string; username: string; tenantId: string } | null; scopes: string[] }>;
  acquireTokenSilent(req: { scopes: string[]; account: { homeAccountId: string }; forceRefresh?: boolean }): Promise<{ accessToken: string }>;
  getTokenCache(): {
    getAllAccounts(): Promise<Array<{ homeAccountId: string; username: string; tenantId: string }>>;
    removeAccount(account: { homeAccountId: string }): Promise<void>;
  };
}

/** The subset of ConfidentialClientApplication this module uses. Tests pass a fake. */
export interface CcaLike {
  /** `fmiPath` names the agent identity a blueprint asks an exchange token for. ADR-0015. */
  acquireTokenByClientCredential(req: { scopes: string[]; fmiPath?: string }): Promise<{ accessToken: string; expiresOn?: Date | null } | null>;
  acquireTokenOnBehalfOf?(req: { oboAssertion: string; scopes: string[] }): Promise<{ accessToken: string } | null>;
}

export interface CcaFactoryInput {
  authority: string;
  clientId: string;
  clientSecret?: string;
  clientCertificate?: { thumbprintSha256: string; privateKey: string };
  /** An agent identity has no credential of its own; it presents the blueprint's exchange token. */
  clientAssertion?: () => Promise<string>;
}

/** The audience of the token a blueprint exchanges for an agent identity. Commercial cloud. */
const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";

export const AGENT_COMMERCIAL_ONLY =
  "Agent connections are commercial cloud only for now. The token exchange audience and Entra Agent ID availability differ in GCC High.";

export interface MsalAuthOptions {
  clientId: string;
  /** Builds a client for the given authority. Defaults to a real PublicClientApplication. */
  pcaFactory?: (authority: string) => PcaLike | Promise<PcaLike>;
  /** Builds the app-only client. Defaults to a real ConfidentialClientApplication. */
  ccaFactory?: (input: CcaFactoryInput) => CcaLike | Promise<CcaLike>;
  openBrowser?: (url: string) => Promise<void>;
  /** Looks up the tenant display name with a fresh token. Defaults to GET /organization. */
  lookupTenantName?: (accessToken: string, graphOrigin: string) => Promise<string | undefined>;
  /** Where an app-only credential is read from and written to. Required for the app-only paths. */
  secrets?: SecretStore;
  /** Told when a refreshed token carries scopes the stored connection did not list, so the record can follow. */
  onScopesChanged?: (connection: Connection, scopes: string[]) => Promise<void>;
  /** The clock for the refresh cooldown. Tests pass their own. */
  now?: () => number;
}

/** A forced refresh is a round trip to Entra, so a run of genuine 403s gets one per connection per minute. */
const REFRESH_COOLDOWN_MS = 60_000;

export class MsalAuthImpl implements MsalAuth {
  private readonly clientId: string;
  private readonly pcaFactory: (authority: string) => PcaLike | Promise<PcaLike>;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly lookupTenantName: (accessToken: string, graphOrigin: string) => Promise<string | undefined>;
  private readonly ccaFactory: (input: CcaFactoryInput) => CcaLike | Promise<CcaLike>;
  private readonly secrets?: SecretStore;
  private readonly onScopesChanged?: (connection: Connection, scopes: string[]) => Promise<void>;
  private readonly now: () => number;
  private readonly pcas = new Map<string, PcaLike>();
  private readonly ccas = new Map<string, CcaLike>();
  private readonly lastForcedRefresh = new Map<string, number>();

  constructor(opts: MsalAuthOptions) {
    this.clientId = opts.clientId;
    this.pcaFactory = opts.pcaFactory ?? ((authority) => new PublicClientApplication({ auth: { clientId: this.clientId, authority } }) as unknown as PcaLike);
    this.ccaFactory = opts.ccaFactory ?? defaultCcaFactory;
    this.openBrowser = opts.openBrowser ?? (async (url) => { await open(url); });
    this.lookupTenantName = opts.lookupTenantName ?? defaultLookupTenantName;
    this.secrets = opts.secrets;
    this.onScopesChanged = opts.onScopesChanged;
    this.now = opts.now ?? Date.now;
  }

  /** An app-only path without a store is a wiring fault, not something a person can act on. */
  private secretStore(): SecretStore {
    if (!this.secrets) throw new Error("No secret store is configured, so app-only connections cannot be used");
    return this.secrets;
  }

  private async pca(tenant: string, cloud: Cloud): Promise<PcaLike> {
    const authority = `${cloudEndpoints(cloud).authorityBase}/${tenant}`;
    let p = this.pcas.get(authority);
    if (!p) {
      p = await this.pcaFactory(authority);
      this.pcas.set(authority, p);
    }
    return p;
  }

  async signInDelegated(input: { alias?: string; tenantHint?: string; cloud?: Cloud; scopes?: string[]; template?: ScopeTemplate }): Promise<SignInResult> {
    const template = input.template ?? "read";
    const scopes = input.scopes?.length ? input.scopes : scopesForTemplate(template);
    const cloud = cloudOf(input);
    const endpoints = cloudEndpoints(cloud);
    const pca = await this.pca(input.tenantHint ?? "organizations", cloud);
    const result = await pca.acquireTokenInteractive({
      scopes,
      openBrowser: this.openBrowser,
      successTemplate: "<h1>Signed in. You can close this window.</h1>",
      errorTemplate: "<h1>Sign-in failed.</h1><p>Return to your MCP client for details.</p>",
    });
    if (!result.account) throw new Error("Sign-in returned no account");
    const tenantName = await this.lookupTenantName(result.accessToken, endpoints.graphOrigin).catch(() => undefined);
    const alias = input.alias ?? slug(tenantName ?? result.account.tenantId);
    return {
      connection: {
        alias,
        tenantId: result.account.tenantId,
        tenantName,
        cloud,
        kind: "delegated",
        // Explicit scopes control consent, while the chosen template controls server enforcement.
        // Write scopes passed under the read template must not let execute write through the connection.
        mode: modeForTemplate(template),
        clientId: this.clientId,
        homeAccountId: result.account.homeAccountId,
        username: result.account.username,
        scopes: scopesFromAccessToken(result.accessToken) ?? result.scopes ?? scopes,
        requestedScopes: scopes,
        addedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Signs in as the application itself, proving the credential before anything is kept.
   *
   * The token is acquired first and the keychain is written only once it comes back. A credential
   * that cannot get a token is not a connection, and storing it first would move that discovery
   * from setup time, where the person is still at the terminal with the registration open, to the
   * first Graph call some hours later.
   */
  async signInAppOnly(input: AppOnlySignInInput): Promise<SignInResult> {
    const secrets = this.secretStore();
    // Built fresh rather than taken from the cache, because this call exists to test a credential
    // that may differ from the one an earlier client in this process was built with.
    const cloud = cloudOf(input);
    const endpoints = cloudEndpoints(cloud);
    const client = await this.buildCca(input.tenantId, input.clientId, cloud, input.credential, input.certPath);
    const result = await client.cca.acquireTokenByClientCredential({ scopes: [endpoints.graphScopeDefault] });
    if (!result?.accessToken) throw new Error(`Client credentials sign-in for ${input.clientId} in tenant ${input.tenantId} returned no token`);

    const tenantName = await this.lookupTenantName(result.accessToken, endpoints.graphOrigin).catch(() => undefined);
    await secrets.set(appOnlySecretAccount(input.tenantId, input.clientId), input.credential);
    return {
      connection: {
        alias: input.alias ?? slug(tenantName ?? input.tenantId),
        tenantId: input.tenantId,
        tenantName,
        cloud,
        kind: "app",
        // App-only gets no scope template, so the mode is the only control on this path and the
        // person adding the connection chose it. ADR-0012.
        mode: input.mode,
        clientId: input.clientId,
        // The credential is deliberately absent: it went to the keychain a few lines up, and this
        // record is written to a plain JSON file. Never add a secret field here. ADR-0007.
        ...(input.certPath ? { certPath: input.certPath, certThumbprint: client.thumbprintSha256 } : {}),
        scopes: rolesFromAccessToken(result.accessToken) ?? [],
        addedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Signs in a person and has an agent identity act for them, in the three hops of ADR-0015.
   *
   * The blueprint's credential is proved first, before the browser opens, for the reason
   * `signInAppOnly` gives: a credential that cannot get a token is not a connection, and the
   * person is still at the terminal now. Nothing is written to the keychain until every hop worked.
   */
  async signInAgent(input: AgentSignInInput): Promise<SignInResult> {
    const cloud = cloudOf(input);
    if (cloud !== "commercial") throw new Error(AGENT_COMMERCIAL_ONLY);
    const secrets = this.secretStore();
    const endpoints = cloudEndpoints(cloud);
    const blueprint = await this.buildCca(input.tenantId, input.blueprintId, cloud, input.credential, input.certPath);
    await exchangeToken(blueprint.cca, input.blueprintId, input.agentId);

    const pca = await this.pca(input.tenantId, cloud);
    const person = await pca.acquireTokenInteractive({
      scopes: [agentAccessScope(input.blueprintId)],
      openBrowser: this.openBrowser,
      successTemplate: "<h1>Signed in. You can close this window.</h1>",
      errorTemplate: "<h1>Sign-in failed.</h1><p>Return to your terminal for details.</p>",
    });
    if (!person.account) throw new Error("Sign-in returned no account");

    const agent = await this.ccaFactory({
      authority: `${endpoints.authorityBase}/${input.tenantId}`,
      clientId: input.agentId,
      clientAssertion: () => exchangeToken(blueprint.cca, input.blueprintId, input.agentId),
    });
    const graphToken = await onBehalfOf(agent, person.accessToken, endpoints.graphScopeDefault, input.agentId);
    const tenantName = await this.lookupTenantName(graphToken, endpoints.graphOrigin).catch(() => undefined);
    await secrets.set(appOnlySecretAccount(input.tenantId, input.blueprintId), input.credential);
    return {
      connection: {
        alias: input.alias ?? slug(tenantName ?? input.tenantId),
        tenantId: input.tenantId,
        tenantName,
        cloud,
        kind: "agent",
        mode: input.mode,
        clientId: this.clientId,
        homeAccountId: person.account.homeAccountId,
        username: person.account.username,
        agentId: input.agentId,
        blueprintId: input.blueprintId,
        // The credential went to the keychain above. Never add it here. ADR-0007.
        ...(input.certPath ? { certPath: input.certPath, certThumbprint: blueprint.thumbprintSha256 } : {}),
        scopes: scopesFromAccessToken(graphToken) ?? [],
        addedAt: new Date().toISOString(),
      },
    };
  }

  async getGraphToken(connection: Connection): Promise<string> {
    if (connection.kind === "app") return this.appOnlyToken(connection);
    if (connection.kind === "agent") return this.agentToken(connection);
    // Named scopes are required because `.default` asks Entra for the client's statically configured permissions,
    // and the shared Graph CLI app can therefore omit dynamically consented scopes (#42). A scope consented
    // outside the server is a different case: MSAL keeps serving the token cached before it. See refreshGraphToken.
    return this.delegatedToken(connection, false);
  }

  /**
   * A token Entra issues afresh, returned only when it carries scopes the connection did not list.
   *
   * Consent granted outside the server (the Entra portal, Graph PowerShell, a consent prompt) never
   * reaches the cached token: MSAL matches a cached token whose scopes contain the ones asked for,
   * and the stored scopes do not name the new one, so the pre-consent token keeps answering until it
   * expires. A forced refresh asks Entra again with the same stored scopes, and Entra puts every
   * granted scope in the answer. Measured live, docs/measurements/2026-09-30-consent-outside-the-server.md.
   */
  async refreshGraphToken(connection: Connection): Promise<string | undefined> {
    // Client credentials have no consent step, and `.default` already returns every granted role.
    if (connection.kind !== "delegated") return undefined;
    const last = this.lastForcedRefresh.get(connection.alias);
    if (last !== undefined && this.now() - last < REFRESH_COOLDOWN_MS) return undefined;
    this.lastForcedRefresh.set(connection.alias, this.now());

    const token = await this.delegatedToken(connection, true);
    const scopes = scopesFromAccessToken(token);
    if (!scopes) return undefined;
    const known = new Set(connection.scopes);
    if (!scopes.some((scope) => !SIGN_IN_SCOPES.has(scope) && !known.has(scope))) return undefined;
    await this.onScopesChanged?.(connection, scopes);
    return token;
  }

  private async delegatedToken(connection: Connection, forceRefresh: boolean): Promise<string> {
    if (connection.kind !== "delegated" || !connection.homeAccountId) {
      throw new Error(`Connection "${connection.alias}" is not a delegated connection`);
    }
    const endpoints = cloudEndpoints(cloudOf(connection));
    const pca = await this.pca(connection.tenantId, cloudOf(connection));
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account = accounts.find((a) => a.homeAccountId === connection.homeAccountId);
    if (!account) throw new Error(`No cached sign-in for "${connection.alias}". Run connection_add to sign in again.`);
    const scopes = graphScopesForConnection(connection.scopes, endpoints.graphScopeDefault);
    try {
      const res = await pca.acquireTokenSilent(forceRefresh ? { scopes, account, forceRefresh } : { scopes, account });
      return res.accessToken;
    } catch (err) {
      throw new Error(`Token refresh failed for "${connection.alias}". Run connection_add to sign in again. (${(err as Error).message})`);
    }
  }

  private async appOnlyToken(connection: Connection): Promise<string> {
    const account = appOnlySecretAccount(connection.tenantId, connection.clientId);
    const credential = await this.secretStore().get(account);
    if (credential === undefined) {
      throw new Error(
        `No stored credential for "${connection.alias}". The keychain entry is missing or was cleared. ` +
          `Run \`graphslayer connect --app-only --tenant ${connection.tenantId} --client-id ${connection.clientId}\` to enter it again.`,
      );
    }
    const cloud = cloudOf(connection);
    const endpoints = cloudEndpoints(cloud);
    const key = `${cloud}|${connection.tenantId}|${connection.clientId}`;
    let cca = this.ccas.get(key);
    if (!cca) {
      // Kept for the life of the process so MSAL's own in-memory cache answers the calls after
      // the first one; a client built per call would ask Entra for a token on every Graph request.
      cca = (await this.buildCca(connection.tenantId, connection.clientId, cloud, credential, connection.certPath)).cca;
      this.ccas.set(key, cca);
    }
    // `.default` and nothing else.
    //
    // #42's rule that a token is asked for with the connection's own scopes is about a delegated
    // token, where dynamic consent means a named scope is the only way to get one Entra did not
    // configure statically. Client credentials have no consent step and no dynamic scopes: the
    // permissions are whatever an administrator granted the registration, and `.default` is the
    // only request the flow accepts. Naming a role here is an error, not a narrower ask.
    const result = await cca.acquireTokenByClientCredential({ scopes: [endpoints.graphScopeDefault] });
    if (!result?.accessToken) throw new Error(`Client credentials token request for "${connection.alias}" returned no token`);
    return result.accessToken;
  }

  /**
   * The three hops again, each answered from a cache where MSAL has one: the person's token for
   * the blueprint from the public client's persisted cache, then the blueprint's exchange token
   * and the on-behalf-of token from clients kept for the life of the process.
   */
  private async agentToken(connection: Connection): Promise<string> {
    const { agentId, blueprintId } = connection;
    if (!agentId || !blueprintId || !connection.homeAccountId) {
      throw new Error(`Connection "${connection.alias}" is missing its agent or blueprint id. Run \`graphslayer connect --agent\` to add it again.`);
    }
    const cloud = cloudOf(connection);
    const endpoints = cloudEndpoints(cloud);
    const credential = await this.secretStore().get(appOnlySecretAccount(connection.tenantId, blueprintId));
    if (credential === undefined) {
      throw new Error(
        `No stored credential for "${connection.alias}". The keychain entry is missing or was cleared. ` +
          `Run \`graphslayer connect --agent --tenant ${connection.tenantId} --blueprint-id ${blueprintId} --agent-id ${agentId}\` to enter it again.`,
      );
    }

    const pca = await this.pca(connection.tenantId, cloud);
    const account = (await pca.getTokenCache().getAllAccounts()).find((a) => a.homeAccountId === connection.homeAccountId);
    if (!account) throw new Error(`No cached sign-in for "${connection.alias}". Run \`graphslayer connect --agent\` to sign in again.`);
    let personToken: string;
    try {
      personToken = (await pca.acquireTokenSilent({ scopes: [agentAccessScope(blueprintId)], account })).accessToken;
    } catch (err) {
      throw new Error(`Token refresh failed for "${connection.alias}". Run \`graphslayer connect --agent\` to sign in again. (${(err as Error).message})`);
    }

    const blueprintKey = `${cloud}|${connection.tenantId}|${blueprintId}`;
    let blueprint = this.ccas.get(blueprintKey);
    if (!blueprint) {
      blueprint = (await this.buildCca(connection.tenantId, blueprintId, cloud, credential, connection.certPath)).cca;
      this.ccas.set(blueprintKey, blueprint);
    }
    const agentKey = `${cloud}|${connection.tenantId}|${blueprintId}|${agentId}`;
    let agent = this.ccas.get(agentKey);
    if (!agent) {
      const exchanger = blueprint;
      agent = await this.ccaFactory({
        authority: `${endpoints.authorityBase}/${connection.tenantId}`,
        clientId: agentId,
        clientAssertion: () => exchangeToken(exchanger, blueprintId, agentId),
      });
      this.ccas.set(agentKey, agent);
    }
    return onBehalfOf(agent, personToken, endpoints.graphScopeDefault, agentId);
  }

  private async buildCca(
    tenantId: string,
    clientId: string,
    cloud: Cloud,
    credential: string,
    certPath?: string,
  ): Promise<{ cca: CcaLike; thumbprintSha256?: string }> {
    const authority = `${cloudEndpoints(cloud).authorityBase}/${tenantId}`;
    if (certPath) {
      const cert = await readClientCertificate(certPath, credential);
      return { cca: await this.ccaFactory({ authority, clientId, clientCertificate: cert }), thumbprintSha256: cert.thumbprintSha256 };
    }
    return { cca: await this.ccaFactory({ authority, clientId, clientSecret: credential }) };
  }

  async removeAccount(connection: Connection): Promise<void> {
    if (!connection.homeAccountId) return;
    const pca = await this.pca(connection.tenantId, cloudOf(connection));
    const cache = pca.getTokenCache();
    const account = (await cache.getAllAccounts()).find((a) => a.homeAccountId === connection.homeAccountId);
    if (account) await cache.removeAccount(account);
  }
}

/** The scope a person's token must carry for the blueprint, so the agent can act for them. ADR-0015. */
export function agentAccessScope(blueprintId: string): string {
  return `api://${blueprintId}/access_agent`;
}

/** Hop 2: the blueprint asks for a token that names the agent identity in `fmi_path`. */
async function exchangeToken(blueprint: CcaLike, blueprintId: string, agentId: string): Promise<string> {
  const result = await blueprint.acquireTokenByClientCredential({ scopes: [TOKEN_EXCHANGE_SCOPE], fmiPath: agentId });
  if (!result?.accessToken) throw new Error(`Blueprint ${blueprintId} returned no exchange token for agent ${agentId}`);
  return result.accessToken;
}

/** Hop 3: the agent identity trades the person's token for a Graph token. `.default` brings the inherited scopes. */
async function onBehalfOf(agent: CcaLike, personToken: string, graphScopeDefault: string, agentId: string): Promise<string> {
  if (!agent.acquireTokenOnBehalfOf) throw new Error("The confidential client cannot run the on-behalf-of flow");
  const result = await agent.acquireTokenOnBehalfOf({ oboAssertion: personToken, scopes: [graphScopeDefault] });
  if (!result?.accessToken) throw new Error(`Agent ${agentId} returned no Graph token`);
  return result.accessToken;
}

export function graphScopesForConnection(scopes: string[], graphScopeDefault: string): string[] {
  const graphScopes = scopes.filter((scope) => !SIGN_IN_SCOPES.has(scope));
  return graphScopes.length ? graphScopes : [graphScopeDefault];
}

/** Reads an unverified token only to report granted scopes; security decisions must not depend on these claims. */
export function scopesFromAccessToken(accessToken: string): string[] | undefined {
  const claims = claimsFromAccessToken(accessToken);
  if (typeof claims?.scp !== "string") return undefined;
  return claims.scp.split(/\s+/).filter(Boolean);
}

/**
 * The application-permission sibling of `scopesFromAccessToken`.
 *
 * An app-only token carries its permissions in `roles`, a JSON array, and never in `scp`, which
 * is why reading one with the delegated decoder returns nothing rather than a short list. Same
 * caveat: unverified, for reporting only.
 */
export function rolesFromAccessToken(accessToken: string): string[] | undefined {
  const roles = claimsFromAccessToken(accessToken)?.roles;
  if (!Array.isArray(roles)) return undefined;
  return roles.filter((role): role is string => typeof role === "string");
}

function claimsFromAccessToken(accessToken: string): { scp?: unknown; roles?: unknown } | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="), "base64").toString("utf8");
    return JSON.parse(payload) as { scp?: unknown; roles?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * Turns a PEM holding a certificate and its encrypted private key into what MSAL wants.
 *
 * Node's own crypto covers both halves, so a certificate connection costs no dependency. The
 * fingerprint comes back colon-separated and MSAL wants bare hex, hence the strip.
 */
export async function readClientCertificate(certPath: string, passphrase: string): Promise<{ thumbprintSha256: string; privateKey: string }> {
  const pem = await fs.readFile(certPath, "utf8");
  const thumbprintSha256 = new X509Certificate(pem).fingerprint256.replace(/:/g, "");
  const privateKey = createPrivateKey({ key: pem, passphrase }).export({ type: "pkcs8", format: "pem" }).toString();
  return { thumbprintSha256, privateKey };
}

function defaultCcaFactory(input: CcaFactoryInput): CcaLike {
  return new ConfidentialClientApplication({
    auth: {
      clientId: input.clientId,
      authority: input.authority,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      ...(input.clientCertificate ? { clientCertificate: input.clientCertificate } : {}),
      // A callback, not a string, so MSAL asks for a fresh exchange token whenever it needs one.
      ...(input.clientAssertion ? { clientAssertion: input.clientAssertion } : {}),
    },
  }) as unknown as CcaLike;
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tenant";
}

async function defaultLookupTenantName(accessToken: string, graphOrigin: string): Promise<string | undefined> {
  const res = await fetch(`${graphOrigin}/v1.0/organization?$select=displayName`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { value?: Array<{ displayName?: string }> };
  return body.value?.[0]?.displayName;
}

/** Builds the real PublicClientApplication with the OS keychain cache. Used by the stdio entry point. */
export async function makeRealPcaFactory(config: Config): Promise<(authority: string) => Promise<PcaLike>> {
  let cachePlugin: PersistenceCachePlugin | undefined;
  if (config.tokenCacheEnabled) {
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: config.msalCacheFile,
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "graphslayer",
      accountName: "msal-token-cache",
      usePlaintextFileOnLinux: false,
    });
    cachePlugin = new PersistenceCachePlugin(persistence);
  }
  return async (authority: string) => {
    const configuration: Configuration = {
      auth: { clientId: config.clientId, authority },
      ...(cachePlugin ? { cache: { cachePlugin } } : {}),
    };
    return new PublicClientApplication(configuration) as unknown as PcaLike;
  };
}
