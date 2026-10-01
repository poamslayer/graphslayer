import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MsalAuthImpl, readClientCertificate, rolesFromAccessToken, scopesFromAccessToken, type CcaFactoryInput } from "../../../src/core/auth/msal.js";
import { READ_TEMPLATE_SCOPES, READ_WRITE_TEMPLATE_SCOPES } from "../../../src/core/auth/scopes.js";
import { cloudEndpoints } from "../../../src/core/config.js";
import { appOnlySecretAccount, MemorySecretStore } from "../../../src/core/secrets/keychain.js";
import type { Connection } from "../../../src/core/types.js";

const COMMERCIAL_ENDPOINTS = cloudEndpoints("commercial");

function tokenWithClaims(claims: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function accessToken(scopes: string[]): string {
  return tokenWithClaims({ scp: scopes.join(" ") });
}

function tokenScopes(token: string): string[] {
  const payload = token.split(".")[1];
  if (!payload) return [];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { scp?: string };
  return claims.scp?.split(" ") ?? [];
}

function fakePca(options: { interactiveAccessToken?: string; interactiveReportedScopes?: string[] } = {}) {
  const accounts: Array<{ homeAccountId: string; username: string; tenantId: string }> = [];
  const consentedScopes = new Set<string>();
  // Consent granted outside the server (#73). A cached token never carries it; only a token
  // Entra issues afresh does, the way the live tenant behaved.
  const grantedOutside = new Set<string>();
  const staticScopes = ["User.Read"];
  return {
    accounts,
    grantOutside: (scope: string) => grantedOutside.add(scope),
    acquireTokenInteractive: vi.fn(async (req: { scopes: string[] }) => {
      const account = { homeAccountId: "home-1", username: "admin@contoso.com", tenantId: "00000000-0000-0000-0000-000000000001" };
      if (!accounts.some((candidate) => candidate.homeAccountId === account.homeAccountId)) accounts.push(account);
      for (const scope of req.scopes) consentedScopes.add(scope);
      return {
        accessToken: options.interactiveAccessToken ?? accessToken(req.scopes),
        account,
        scopes: options.interactiveReportedScopes ?? req.scopes,
      };
    }),
    acquireTokenSilent: vi.fn(async (req: { scopes: string[]; account: { homeAccountId: string }; forceRefresh?: boolean }) => {
      if (!accounts.find((a) => a.homeAccountId === req.account.homeAccountId)) throw new Error("no account");
      if (req.scopes.length === 1 && req.scopes[0] === COMMERCIAL_ENDPOINTS.graphScopeDefault) {
        return { accessToken: accessToken(staticScopes) };
      }
      for (const scope of req.scopes) {
        if (!consentedScopes.has(scope)) throw new Error("interaction required");
      }
      const extra = req.forceRefresh ? [...grantedOutside].filter((s) => !req.scopes.includes(s)) : [];
      return { accessToken: accessToken([...req.scopes, ...extra]) };
    }),
    getTokenCache: () => ({
      getAllAccounts: async () => accounts,
      removeAccount: vi.fn(async (a: { homeAccountId: string }) => {
        const i = accounts.findIndex((x) => x.homeAccountId === a.homeAccountId);
        if (i >= 0) accounts.splice(i, 1);
      }),
    }),
  };
}

describe("scopesFromAccessToken", () => {
  it("reads scopes only from a well-formed token with an scp claim", () => {
    expect(scopesFromAccessToken(accessToken(["User.Read", "Group.Read.All"]))).toEqual(["User.Read", "Group.Read.All"]);
    expect(scopesFromAccessToken("opaque-token")).toBeUndefined();
    expect(scopesFromAccessToken("header.bm90LWpzb24.signature")).toBeUndefined();
    expect(scopesFromAccessToken(tokenWithClaims({ sub: "principal" }))).toBeUndefined();
  });
});

describe("MsalAuthImpl", () => {
  it("uses the read template by default and returns a read connection", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "contoso" });

    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: READ_TEMPLATE_SCOPES });
    expect(connection.mode).toBe("read");
  });

  it("uses the read-write template and returns a write connection with a live write scope", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "contoso", template: "read-write" });

    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: READ_WRITE_TEMPLATE_SCOPES });
    expect(connection.mode).toBe("write");
    expect(tokenScopes(await auth.getGraphToken(connection))).toContain("User.ReadWrite.All");
  });

  it("lets explicit scopes override a template without changing its mode", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "contoso", template: "read", scopes: ["Group.ReadWrite.All"] });

    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: ["Group.ReadWrite.All"] });
    expect(connection.mode).toBe("read");
  });

  it("keeps the requested scopes apart from a wider token, because consent screen and token can differ", async () => {
    // The shape from #66: tenant-wide consent already held by the shared client id rides along.
    const pca = fakePca({ interactiveAccessToken: accessToken(["Directory.ReadWrite.All", "openid", "profile", "Mail.Read", "Tasks.ReadWrite"]) });
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "contoso", scopes: ["Mail.Read", "Tasks.ReadWrite"] });

    expect(connection.requestedScopes).toEqual(["Mail.Read", "Tasks.ReadWrite"]);
    expect(connection.scopes).toEqual(["Directory.ReadWrite.All", "openid", "profile", "Mail.Read", "Tasks.ReadWrite"]);
  });

  it("records the template's scope list as requested when no explicit scopes are passed", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "contoso" });

    expect(connection.requestedScopes).toEqual(READ_TEMPLATE_SCOPES);
  });

  it("signs in interactively and builds a delegated connection", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });
    const { connection } = await auth.signInDelegated({ alias: "contoso", scopes: ["User.Read"] });
    expect(connection).toMatchObject({
      alias: "contoso",
      tenantId: "00000000-0000-0000-0000-000000000001",
      tenantName: "Contoso",
      kind: "delegated",
      mode: "read",
      clientId: "cid",
      homeAccountId: "home-1",
      username: "admin@contoso.com",
      scopes: ["User.Read"],
    });
    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: ["User.Read"] });
  });

  it("records the scopes carried by the interactive access token", async () => {
    const pca = fakePca({
      interactiveAccessToken: accessToken(["User.Read"]),
      interactiveReportedScopes: ["User.Read", "Group.Read.All"],
    });
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "c", scopes: ["User.Read", "Group.Read.All"] });

    expect(connection.scopes).toEqual(["User.Read"]);
  });

  it("falls back to reported scopes when the interactive access token is opaque", async () => {
    const pca = fakePca({ interactiveAccessToken: "opaque-token", interactiveReportedScopes: ["User.Read"] });
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection } = await auth.signInDelegated({ alias: "c", scopes: ["Group.Read.All"] });

    expect(connection.scopes).toEqual(["User.Read"]);
  });

  it("defaults the alias to the tenant name slug", async () => {
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => fakePca() as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso Ltd" });
    const { connection } = await auth.signInDelegated({});
    expect(connection.alias).toBe("contoso-ltd");
  });

  it("gets a silent token for a stored connection", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });
    const { connection } = await auth.signInDelegated({ alias: "c" });
    expect(tokenScopes(await auth.getGraphToken(connection))).toEqual(connection.scopes);
  });

  it("gets a token carrying a newly added scope", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });

    const { connection: initialConnection } = await auth.signInDelegated({ alias: "c", scopes: ["User.Read"] });
    expect(tokenScopes(await auth.getGraphToken(initialConnection))).toContain("User.Read");

    const addedScope = "DeviceManagementConfiguration.Read.All";
    const { connection: updatedConnection } = await auth.signInDelegated({ alias: "c", scopes: ["User.Read", addedScope] });
    expect(tokenScopes(await auth.getGraphToken(updatedConnection))).toContain(addedScope);
  });

  it.each([
    { description: "no recorded scopes", scopes: [] },
    { description: "only OIDC scopes", scopes: ["openid", "profile", "email", "offline_access"] },
  ])("falls back to .default for a connection with $description", async ({ scopes }) => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "Contoso" });
    const { connection } = await auth.signInDelegated({ alias: "c", scopes: ["User.Read"] });

    const token = await auth.getGraphToken({ ...connection, scopes });

    expect(tokenScopes(token)).toEqual(["User.Read"]);
  });

  it("fails clearly when the account is gone", async () => {
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => fakePca() as never, openBrowser: async () => {}, lookupTenantName: async () => "x" });
    const conn: Connection = { alias: "c", tenantId: "t", kind: "delegated", clientId: "cid", homeAccountId: "missing", scopes: [], addedAt: "" };
    await expect(auth.getGraphToken(conn)).rejects.toThrow(/sign in again/);
  });

  it("removes the account from the cache", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "x" });
    const { connection } = await auth.signInDelegated({ alias: "c" });
    await auth.removeAccount(connection);
    expect(pca.accounts).toHaveLength(0);
  });
});

describe("MsalAuthImpl.refreshGraphToken (#73)", () => {
  async function setup(opts: { now?: () => number } = {}) {
    const pca = fakePca();
    const changed: Array<{ alias: string; scopes: string[] }> = [];
    const auth = new MsalAuthImpl({
      clientId: "cid",
      pcaFactory: () => pca as never,
      openBrowser: async () => {},
      lookupTenantName: async () => "Contoso",
      onScopesChanged: async (c, scopes) => { changed.push({ alias: c.alias, scopes }); },
      ...(opts.now ? { now: opts.now } : {}),
    });
    const { connection } = await auth.signInDelegated({ alias: "c", scopes: ["User.Read"] });
    return { pca, auth, connection, changed };
  }

  it("returns a fresh token carrying a scope granted outside the server, and reports the new scopes", async () => {
    const { pca, auth, connection, changed } = await setup();
    pca.grantOutside("Agreement.Read.All");
    // The cached token is what the bug served: it does not carry the new scope.
    expect(tokenScopes(await auth.getGraphToken(connection))).not.toContain("Agreement.Read.All");

    const token = await auth.refreshGraphToken(connection);

    expect(token && tokenScopes(token)).toContain("Agreement.Read.All");
    expect(pca.acquireTokenSilent.mock.calls.at(-1)?.[0]).toMatchObject({ forceRefresh: true });
    expect(changed).toEqual([{ alias: "c", scopes: ["User.Read", "Agreement.Read.All"] }]);
  });

  it("returns nothing when a fresh token carries no new scope, so a genuine 403 is not retried", async () => {
    const { auth, connection, changed } = await setup();

    expect(await auth.refreshGraphToken(connection)).toBeUndefined();
    expect(changed).toEqual([]);
  });

  it("asks Entra at most once a minute per connection, so a run of genuine 403s costs one refresh", async () => {
    let clock = 1_000_000;
    const { pca, auth, connection } = await setup({ now: () => clock });

    await auth.refreshGraphToken(connection);
    await auth.refreshGraphToken(connection);
    const forced = () => pca.acquireTokenSilent.mock.calls.filter((call) => call[0].forceRefresh).length;
    expect(forced()).toBe(1);

    clock += 60_001;
    pca.grantOutside("Agreement.Read.All");
    expect(await auth.refreshGraphToken(connection)).toBeDefined();
    expect(forced()).toBe(2);
  });

  it("does nothing for an app-only connection, whose .default token already carries every role", async () => {
    const pca = fakePca();
    const auth = new MsalAuthImpl({ clientId: "cid", pcaFactory: () => pca as never, openBrowser: async () => {}, lookupTenantName: async () => "x" });
    const conn: Connection = { alias: "app", tenantId: "t", kind: "app", clientId: "cid", scopes: [], addedAt: "" };

    expect(await auth.refreshGraphToken(conn)).toBeUndefined();
    expect(pca.acquireTokenSilent).not.toHaveBeenCalled();
  });
});

function appOnlyToken(roles: string[]): string {
  return tokenWithClaims({ roles, aud: "https://graph.microsoft.com" });
}

function fakeCca(options: { token?: string; fail?: Error } = {}) {
  const built: CcaFactoryInput[] = [];
  const acquireTokenByClientCredential = vi.fn(async (_req: { scopes: string[] }) => {
    if (options.fail) throw options.fail;
    return { accessToken: options.token ?? appOnlyToken(["User.Read.All"]), expiresOn: new Date(Date.now() + 3600_000) };
  });
  return {
    built,
    acquireTokenByClientCredential,
    factory: (input: CcaFactoryInput) => {
      built.push(input);
      return { acquireTokenByClientCredential };
    },
  };
}

const APP_TENANT = "00000000-0000-0000-0000-0000000000aa";
const APP_CLIENT = "11111111-1111-1111-1111-111111111111";

function appOnlyAuth(cca: ReturnType<typeof fakeCca>, secrets = new MemorySecretStore()) {
  const auth = new MsalAuthImpl({
    clientId: "delegated-cid",
    pcaFactory: () => fakePca() as never,
    ccaFactory: cca.factory,
    secrets,
    openBrowser: async () => {},
    lookupTenantName: async () => "Contoso",
  });
  return { auth, secrets };
}

describe("rolesFromAccessToken", () => {
  it("reads the application permissions an app-only token carries", () => {
    expect(rolesFromAccessToken(appOnlyToken(["User.Read.All", "Group.Read.All"]))).toEqual(["User.Read.All", "Group.Read.All"]);
  });

  it("returns nothing for a token with no readable roles claim", () => {
    expect(rolesFromAccessToken(accessToken(["User.Read"]))).toBeUndefined();
    expect(rolesFromAccessToken("opaque-token")).toBeUndefined();
    expect(rolesFromAccessToken(tokenWithClaims({ roles: "User.Read.All" }))).toBeUndefined();
  });
});

describe("MsalAuthImpl app-only", () => {
  it("uses the GCC High authority for both flows and its Graph resource for client credentials", async () => {
    const pca = fakePca();
    const pcaFactory = vi.fn(() => pca as never);
    const cca = fakeCca();
    const auth = new MsalAuthImpl({
      clientId: "delegated-cid",
      pcaFactory,
      ccaFactory: cca.factory,
      secrets: new MemorySecretStore(),
      openBrowser: async () => {},
      lookupTenantName: async () => "Contoso",
    });

    await auth.signInDelegated({ cloud: "usgov-high" });
    await auth.signInAppOnly({ cloud: "usgov-high", tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret" });

    expect(pcaFactory).toHaveBeenCalledWith("https://login.microsoftonline.us/organizations");
    expect(cca.built[0]).toMatchObject({ authority: `https://login.microsoftonline.us/${APP_TENANT}` });
    expect(cca.acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: ["https://graph.microsoft.us/.default"] });
  });

  it("requests exactly .default and never the connection's own roles", async () => {
    const cca = fakeCca();
    const { auth } = appOnlyAuth(cca);

    await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret" });

    expect(cca.acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: [COMMERCIAL_ENDPOINTS.graphScopeDefault] });
  });

  it("builds an app connection in the chosen mode with the roles the token carries", async () => {
    const cca = fakeCca({ token: appOnlyToken(["User.Read.All", "Group.ReadWrite.All"]) });
    const { auth } = appOnlyAuth(cca);

    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "write", credential: "s3cret", alias: "contoso-app" });

    expect(connection).toMatchObject({
      alias: "contoso-app",
      tenantId: APP_TENANT,
      tenantName: "Contoso",
      kind: "app",
      mode: "write",
      clientId: APP_CLIENT,
      scopes: ["User.Read.All", "Group.ReadWrite.All"],
    });
    expect(connection.username).toBeUndefined();
  });

  it("records no roles rather than inventing them when the token is unreadable", async () => {
    const cca = fakeCca({ token: "opaque-token" });
    const { auth } = appOnlyAuth(cca);

    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret" });

    expect(connection.scopes).toEqual([]);
  });

  it("defaults the alias to the tenant name slug", async () => {
    const { auth } = appOnlyAuth(fakeCca());
    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret" });
    expect(connection.alias).toBe("contoso");
  });

  it("stores the credential in the keychain and keeps it off the connection", async () => {
    const cca = fakeCca();
    const { auth, secrets } = appOnlyAuth(cca);
    const secret = "correct-horse-battery-staple";

    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: secret });

    expect(await secrets.get(appOnlySecretAccount(APP_TENANT, APP_CLIENT))).toBe(secret);
    const serialized = JSON.stringify(connection);
    for (let end = 4; end <= secret.length; end += 1) {
      expect(serialized).not.toContain(secret.slice(0, end));
    }
    expect(cca.built[0]).toMatchObject({ clientSecret: secret });
  });

  it("stores nothing when the token cannot be acquired, so a bad credential is not kept", async () => {
    const cca = fakeCca({ fail: new Error("AADSTS7000215: Invalid client secret provided") });
    const { auth, secrets } = appOnlyAuth(cca);

    await expect(auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "wrong" })).rejects.toThrow(/Invalid client secret/);

    expect(await secrets.get(appOnlySecretAccount(APP_TENANT, APP_CLIENT))).toBeUndefined();
  });

  it("reads the credential back from the store to get a token for a stored connection", async () => {
    const cca = fakeCca({ token: appOnlyToken(["Directory.Read.All"]) });
    const { auth } = appOnlyAuth(cca);
    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret" });
    cca.built.length = 0;

    const token = await auth.getGraphToken(connection);

    expect(rolesFromAccessToken(token)).toEqual(["Directory.Read.All"]);
    expect(cca.built[0]).toMatchObject({ clientId: APP_CLIENT, clientSecret: "s3cret", authority: `${COMMERCIAL_ENDPOINTS.authorityBase}/${APP_TENANT}` });
    expect(cca.acquireTokenByClientCredential).toHaveBeenLastCalledWith({ scopes: [COMMERCIAL_ENDPOINTS.graphScopeDefault] });
  });

  it("fails with an actionable error naming the alias when the keychain entry is gone", async () => {
    const cca = fakeCca();
    const { auth, secrets } = appOnlyAuth(cca);
    const { connection } = await auth.signInAppOnly({ tenantId: APP_TENANT, clientId: APP_CLIENT, mode: "read", credential: "s3cret", alias: "contoso-app" });
    await secrets.delete(appOnlySecretAccount(APP_TENANT, APP_CLIENT));

    await expect(auth.getGraphToken(connection)).rejects.toThrow(/No stored credential for "contoso-app"[\s\S]*connect --app-only/);
  });

  it("still refuses a connection kind it does not know", async () => {
    const { auth } = appOnlyAuth(fakeCca());
    const conn = { alias: "weird", tenantId: "t", kind: "device" as unknown as Connection["kind"], clientId: "c", scopes: [], addedAt: "" };
    await expect(auth.getGraphToken(conn)).rejects.toThrow(/not a delegated connection/);
  });
});

/**
 * A real self-signed certificate and its password-protected key, in the one file shape a person
 * gets out of a registration. Generated at test time rather than checked in, so the repository
 * carries no key material, and made once because generating an RSA key is not free.
 */
let certFixture: { pemPath: string; passphrase: string; certPem: string } | undefined;

/**
 * Whether this machine can mint the fixture at all.
 *
 * Node cannot sign an X.509 certificate and nothing in this dependency tree can either, so the
 * fixture needs `openssl` on PATH. It is present on macOS and on every common Linux image, but
 * "present here" is not "present everywhere", and a suite that dies on a container without it
 * would be blaming the wrong thing. The certificate tests skip instead, loudly enough that a
 * skip is not mistaken for a pass.
 */
const opensslAvailable = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function clientCertificateFixture() {
  if (certFixture) return certFixture;
  const dir = mkdtempSync(path.join(tmpdir(), "graphslayer-cert-"));
  const plainKeyFile = path.join(dir, "plain-key.pem");
  const certFile = path.join(dir, "cert.pem");
  const pemPath = path.join(dir, "app.pem");
  // Spaces on purpose: a certificate password is not trimmed anywhere on this path.
  const passphrase = "pa ss phrase";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // Node cannot mint an X.509 certificate and no dependency here can either, so openssl signs one
  // over the unencrypted key. Only the key written into the fixture is encrypted.
  writeFileSync(plainKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  execFileSync("openssl", ["req", "-new", "-x509", "-key", plainKeyFile, "-subj", "/CN=graphslayer-test", "-days", "1", "-out", certFile]);
  const certPem = readFileSync(certFile, "utf8");
  const encryptedKey = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }).toString();
  writeFileSync(pemPath, `${certPem}\n${encryptedKey}`);
  certFixture = { pemPath, passphrase, certPem };
  return certFixture;
}

describe.skipIf(!opensslAvailable)("readClientCertificate (needs openssl on PATH to mint a fixture)", () => {
  it("returns the colon-free SHA-256 thumbprint and the decrypted private key", async () => {
    const fixture = clientCertificateFixture();

    const cert = await readClientCertificate(fixture.pemPath, fixture.passphrase);

    expect(cert.thumbprintSha256).toBe(new X509Certificate(fixture.certPem).fingerprint256.replace(/:/g, ""));
    expect(cert.thumbprintSha256).not.toContain(":");
    expect(cert.privateKey).toContain("BEGIN PRIVATE KEY");
    // Decrypted: loading it back needs no passphrase.
    expect(createPrivateKey(cert.privateKey).asymmetricKeyType).toBe("rsa");
  });

  it("refuses the wrong password rather than passing a locked key to MSAL", async () => {
    const fixture = clientCertificateFixture();
    await expect(readClientCertificate(fixture.pemPath, "not-the-password")).rejects.toThrow();
  });
});

describe.skipIf(!opensslAvailable)("MsalAuthImpl app-only with a certificate (needs openssl on PATH to mint a fixture)", () => {
  it("passes MSAL the thumbprint and key, and records the path and thumbprint on the connection", async () => {
    const fixture = clientCertificateFixture();
    const cca = fakeCca();
    const { auth, secrets } = appOnlyAuth(cca);

    const { connection } = await auth.signInAppOnly({
      tenantId: APP_TENANT,
      clientId: APP_CLIENT,
      mode: "read",
      credential: fixture.passphrase,
      certPath: fixture.pemPath,
      alias: "contoso-cert",
    });

    const expected = new X509Certificate(fixture.certPem).fingerprint256.replace(/:/g, "");
    expect(connection).toMatchObject({ kind: "app", certPath: fixture.pemPath, certThumbprint: expected });
    expect(cca.built[0].clientCertificate).toMatchObject({ thumbprintSha256: expected });
    expect(cca.built[0].clientCertificate?.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(cca.built[0].clientSecret).toBeUndefined();
    // The password decrypts the key, so it is a credential and belongs in the keychain like any other.
    expect(await secrets.get(appOnlySecretAccount(APP_TENANT, APP_CLIENT))).toBe(fixture.passphrase);
    expect(JSON.stringify(connection)).not.toContain(fixture.passphrase);
  });

  it("rebuilds the certificate client from the keychain password when getting a later token", async () => {
    const fixture = clientCertificateFixture();
    const cca = fakeCca();
    const { auth } = appOnlyAuth(cca);
    const { connection } = await auth.signInAppOnly({
      tenantId: APP_TENANT,
      clientId: APP_CLIENT,
      mode: "read",
      credential: fixture.passphrase,
      certPath: fixture.pemPath,
    });
    cca.built.length = 0;

    await auth.getGraphToken(connection);

    expect(cca.built[0].clientCertificate?.thumbprintSha256).toBe(connection.certThumbprint);
  });
});

describe("MsalAuthImpl agent connections (#72)", () => {
  const TENANT = "00000000-0000-0000-0000-0000000000bb";
  const BLUEPRINT = "22222222-2222-2222-2222-222222222222";
  const AGENT = "33333333-3333-3333-3333-333333333333";
  const EXCHANGE = "api://AzureADTokenExchange/.default";
  const AGENT_SCOPES = ["openid", "profile", "AuditLog.Read.All", "Directory.Read.All", "Policy.Read.All"];

  /** One factory, two kinds of client: the blueprint (client credentials) and the agent (on behalf of). */
  function fakeAgentClients(options: { blueprintFails?: Error } = {}) {
    const built: CcaFactoryInput[] = [];
    const clientCredential = vi.fn(async (req: { scopes: string[]; fmiPath?: string }) => {
      if (options.blueprintFails) throw options.blueprintFails;
      return { accessToken: tokenWithClaims({ aud: "token-exchange", sub: `/eid1/x/${req.fmiPath}` }) };
    });
    const onBehalfOf = vi.fn(async (_req: { oboAssertion: string; scopes: string[] }) => ({
      accessToken: tokenWithClaims({ scp: AGENT_SCOPES.join(" "), appid: AGENT, upn: "admin@contoso.com" }),
    }));
    const assertions: string[] = [];
    return {
      built,
      clientCredential,
      onBehalfOf,
      assertions,
      factory: (input: CcaFactoryInput) => {
        built.push(input);
        return {
          acquireTokenByClientCredential: clientCredential,
          acquireTokenOnBehalfOf: vi.fn(async (req: { oboAssertion: string; scopes: string[] }) => {
            // The agent client proves itself with the blueprint's exchange token, fetched on demand.
            if (input.clientAssertion) assertions.push(await input.clientAssertion());
            return onBehalfOf(req);
          }),
        };
      },
    };
  }

  function agentAuth(clients = fakeAgentClients(), secrets = new MemorySecretStore()) {
    const pca = fakePca();
    const auth = new MsalAuthImpl({
      clientId: "public-cid",
      pcaFactory: () => pca as never,
      ccaFactory: clients.factory,
      secrets,
      openBrowser: async () => {},
      lookupTenantName: async () => "Contoso",
    });
    return { auth, pca, clients, secrets };
  }

  const input = { tenantId: TENANT, blueprintId: BLUEPRINT, agentId: AGENT, mode: "read" as const, credential: "s3cret", alias: "agent" };

  it("runs the three hops: the person's token for the blueprint, the exchange token for the agent, then on behalf of", async () => {
    const { auth, pca, clients } = agentAuth();

    const { connection } = await auth.signInAgent(input);

    expect(pca.acquireTokenInteractive.mock.calls[0][0]).toMatchObject({ scopes: [`api://${BLUEPRINT}/access_agent`] });
    expect(clients.clientCredential.mock.calls[0][0]).toEqual({ scopes: [EXCHANGE], fmiPath: AGENT });
    expect(clients.built.map((b) => b.clientId)).toEqual([BLUEPRINT, AGENT]);
    expect(clients.onBehalfOf.mock.calls[0][0]).toEqual({ oboAssertion: accessToken([`api://${BLUEPRINT}/access_agent`]), scopes: [COMMERCIAL_ENDPOINTS.graphScopeDefault] });
    expect(clients.assertions[0]).toContain(".");
    expect(connection).toMatchObject({
      alias: "agent", tenantId: TENANT, tenantName: "Contoso", kind: "agent", mode: "read", clientId: "public-cid",
      agentId: AGENT, blueprintId: BLUEPRINT, username: "admin@contoso.com", homeAccountId: "home-1", scopes: AGENT_SCOPES,
    });
  });

  it("keeps the credential in the keychain under the blueprint, and only after every hop worked", async () => {
    const { auth, secrets } = agentAuth();
    const { connection } = await auth.signInAgent(input);

    expect(await secrets.get(appOnlySecretAccount(TENANT, BLUEPRINT))).toBe("s3cret");
    expect(JSON.stringify(connection)).not.toContain("s3cret");
  });

  it("stores nothing and opens no browser when the blueprint credential is refused", async () => {
    const { auth, pca, secrets } = agentAuth(fakeAgentClients({ blueprintFails: new Error("AADSTS7000215: Invalid client secret") }));

    await expect(auth.signInAgent(input)).rejects.toThrow(/7000215/);
    expect(pca.acquireTokenInteractive).not.toHaveBeenCalled();
    expect(await secrets.get(appOnlySecretAccount(TENANT, BLUEPRINT))).toBeUndefined();
  });

  it("refuses GCC High, where the token exchange and Agent ID are not the same", async () => {
    const { auth, clients } = agentAuth();

    await expect(auth.signInAgent({ ...input, cloud: "usgov-high" })).rejects.toThrow(/commercial/i);
    expect(clients.built).toEqual([]);
  });

  it("gets a later token through the same three hops, with the person's token taken silently", async () => {
    const { auth, pca, clients } = agentAuth();
    const { connection } = await auth.signInAgent(input);

    const token = await auth.getGraphToken(connection);

    expect(tokenScopes(token)).toEqual(AGENT_SCOPES);
    expect(pca.acquireTokenSilent.mock.calls.at(-1)?.[0]).toMatchObject({ scopes: [`api://${BLUEPRINT}/access_agent`] });
    expect(clients.onBehalfOf).toHaveBeenCalledTimes(2);
  });

  it("builds each client once per process, so MSAL's own caches answer the calls after the first", async () => {
    const { auth, clients } = agentAuth();
    const { connection } = await auth.signInAgent(input);
    const afterSignIn = clients.built.length;

    await auth.getGraphToken(connection);
    await auth.getGraphToken(connection);

    expect(clients.built.length - afterSignIn).toBe(2);
  });

  it("names the command to run when the keychain entry is gone", async () => {
    const { auth, secrets } = agentAuth();
    const { connection } = await auth.signInAgent(input);
    await secrets.delete(appOnlySecretAccount(TENANT, BLUEPRINT));

    await expect(auth.getGraphToken(connection)).rejects.toThrow(/connect --agent/);
  });

  it("does not try the #73 refresh, because an agent's scopes come from the blueprint", async () => {
    const { auth } = agentAuth();
    const { connection } = await auth.signInAgent(input);

    expect(await auth.refreshGraphToken(connection)).toBeUndefined();
  });
});
