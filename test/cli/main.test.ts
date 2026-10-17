import { describe, it, expect, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import type { Connection } from "../../src/core/types.js";
import {
  APP_ONLY_NEEDS_CLIENT_ID,
  APP_ONLY_NEEDS_MODE,
  APP_ONLY_NEEDS_TENANT,
  APP_ONLY_REJECTS_SCOPES,
  APP_ONLY_REJECTS_TEMPLATE,
  AGENT_NEEDS_IDS,
  AGENT_NEEDS_MODE,
  AGENT_NEEDS_TENANT,
  AGENT_REJECTS_APP_ONLY,
  connectAgent,
  connectAppOnly,
  headlessBrowser,
  isEntryPoint,
  parseArgs,
} from "../../src/cli/main.js";

describe("parseArgs", () => {
  it("defaults to serve", () => {
    expect(parseArgs([])).toEqual({ command: "serve" });
  });
  it("parses connect with options", () => {
    expect(parseArgs(["connect", "--alias", "contoso", "--tenant", "contoso.com", "--template", "read-write", "--scopes", "User.Read.All,Group.Read.All"])).toEqual({
      command: "connect",
      alias: "contoso",
      tenantHint: "contoso.com",
      template: "read-write",
      scopes: ["User.Read.All", "Group.Read.All"],
    });
  });
  it("rejects an unknown connection template", () => {
    expect(() => parseArgs(["connect", "--template", "admin"])).toThrow('Unknown template "admin". Expected read or read-write.');
  });
  it("parses connections and help", () => {
    expect(parseArgs(["connections"])).toEqual({ command: "connections" });
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
  });
  it("rejects unknown commands", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/Unknown command/);
  });
});

describe("headless sign-in (#8)", () => {
  it("parses --no-browser with the default port", () => {
    expect(parseArgs(["connect", "--no-browser", "--alias", "contoso"])).toEqual({ command: "connect", alias: "contoso", headless: { kind: "redirect", port: 8400 } });
  });
  it("parses --port after --no-browser, in either order", () => {
    expect(parseArgs(["connect", "--port", "9001", "--no-browser"])).toMatchObject({ headless: { kind: "redirect", port: 9001 } });
  });
  it("passes headless through on an agent connect", () => {
    expect(parseArgs(["connect", "--agent", "--tenant", "t", "--blueprint-id", "b", "--agent-id", "a", "--mode", "read", "--no-browser"])).toMatchObject({ command: "connect-agent", headless: { kind: "redirect", port: 8400 } });
  });
  it("rejects --port without --no-browser, a bad port, and headless with --app-only", () => {
    expect(() => parseArgs(["connect", "--port", "9001"])).toThrow("--port is only used with --no-browser.");
    expect(() => parseArgs(["connect", "--no-browser", "--port", "80"])).toThrow(/1024 to 65535/);
    expect(() => parseArgs(["connect", "--no-browser", "--port", "abc"])).toThrow(/1024 to 65535/);
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t", "--client-id", "c", "--mode", "read", "--no-browser"])).toThrow(/no browser step/);
  });
  it("prints the address and how the redirect gets back, naming the port MSAL actually got", async () => {
    const out: string[] = [];
    const stderr = new Writable({ write(c, _e, done) { out.push(c.toString()); done(); } });
    const browser = headlessBrowser({ kind: "redirect", port: 8400 }, stderr);
    const url = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8401";

    await browser.openBrowser!(url);

    expect(browser.port).toBe(8400);
    const text = out.join("");
    expect(text).toContain(url);
    expect(text).toContain("ssh -L 8401:localhost:8401");
    expect(text).toContain("curl '<address>'");
  });
});

describe("device code sign-in (#12)", () => {
  it("parses --device-code on a delegated and an agent connect", () => {
    expect(parseArgs(["connect", "--device-code", "--tenant", "contoso.com"])).toEqual({ command: "connect", tenantHint: "contoso.com", headless: { kind: "device-code" } });
    expect(parseArgs(["connect", "--agent", "--tenant", "t", "--blueprint-id", "b", "--agent-id", "a", "--mode", "read", "--device-code"])).toMatchObject({ headless: { kind: "device-code" } });
  });
  it("rejects --device-code with --no-browser, --port or --app-only", () => {
    expect(() => parseArgs(["connect", "--device-code", "--no-browser"])).toThrow(/no redirect/);
    expect(() => parseArgs(["connect", "--device-code", "--port", "9001"])).toThrow(/no redirect/);
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t", "--client-id", "c", "--mode", "read", "--device-code"])).toThrow(/no browser step/);
  });
  it("prints MSAL's message with the code", () => {
    const out: string[] = [];
    const stderr = new Writable({ write(c, _e, done) { out.push(c.toString()); done(); } });
    const browser = headlessBrowser({ kind: "device-code" }, stderr);

    browser.deviceCode!("To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC123 to authenticate.");

    expect(out.join("")).toContain("enter the code ABC123");
    expect(browser.openBrowser).toBeUndefined();
  });
});

describe("parseArgs for app-only", () => {
  it("parses --app-only with its required flags", () => {
    expect(parseArgs(["connect", "--app-only", "--tenant", "t-1", "--client-id", "c-1", "--mode", "write", "--alias", "contoso", "--cert", "/tmp/app.pem"])).toEqual({
      command: "connect-app-only",
      tenantId: "t-1",
      clientId: "c-1",
      mode: "write",
      alias: "contoso",
      certPath: "/tmp/app.pem",
    });
  });

  it("accepts --app-only written last, after the flags that take values", () => {
    expect(parseArgs(["connect", "--tenant", "t-1", "--client-id", "c-1", "--mode", "read", "--app-only"])).toEqual({
      command: "connect-app-only",
      tenantId: "t-1",
      clientId: "c-1",
      mode: "read",
    });
  });

  it("rejects a missing --tenant", () => {
    expect(() => parseArgs(["connect", "--app-only", "--client-id", "c-1", "--mode", "read"])).toThrow(APP_ONLY_NEEDS_TENANT);
  });

  it("rejects a missing --client-id and says why the default one does not apply", () => {
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t-1", "--mode", "read"])).toThrow(APP_ONLY_NEEDS_CLIENT_ID);
    expect(APP_ONLY_NEEDS_CLIENT_ID).toContain("public client");
  });

  it("rejects a missing --mode rather than defaulting one", () => {
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t-1", "--client-id", "c-1"])).toThrow(APP_ONLY_NEEDS_MODE);
  });

  it("rejects an unknown --mode by naming both choices", () => {
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t-1", "--client-id", "c-1", "--mode", "admin"])).toThrow('Unknown mode "admin". Expected read or write.');
  });

  it("rejects --template combined with --app-only and explains .default", () => {
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t-1", "--client-id", "c-1", "--mode", "read", "--template", "read-write"])).toThrow(APP_ONLY_REJECTS_TEMPLATE);
    expect(APP_ONLY_REJECTS_TEMPLATE).toContain(".default");
  });

  it("rejects --scopes combined with --app-only", () => {
    expect(() => parseArgs(["connect", "--app-only", "--tenant", "t-1", "--client-id", "c-1", "--mode", "read", "--scopes", "User.Read.All"])).toThrow(APP_ONLY_REJECTS_SCOPES);
  });

  it("rejects the app-only flags on a delegated connect", () => {
    expect(() => parseArgs(["connect", "--client-id", "c-1"])).toThrow("--client-id is only used with --app-only. A delegated sign-in uses the configured client id.");
    expect(() => parseArgs(["connect", "--mode", "read"])).toThrow("--mode is only used with --app-only or --agent. A delegated connection takes its mode from --template.");
    expect(() => parseArgs(["connect", "--cert", "/tmp/app.pem"])).toThrow("--cert is only used with --app-only or --agent. A delegated sign-in happens in the browser.");
  });
});

describe("connectAppOnly", () => {
  function fakes() {
    const connection: Connection = {
      alias: "contoso-app",
      tenantId: "t-1",
      tenantName: "Contoso",
      kind: "app",
      mode: "write",
      clientId: "c-1",
      scopes: ["User.Read.All"],
      addedAt: "2026-09-16T00:00:00.000Z",
    };
    const signInAppOnly = vi.fn(async () => ({ connection }));
    const upsert = vi.fn(async () => {});
    const stdout: string[] = [];
    const stderr: string[] = [];
    const input = new PassThrough();
    const io = {
      input,
      output: new Writable({ write(c, _e, done) { stderr.push(c.toString()); done(); } }),
      stdout: new Writable({ write(c, _e, done) { stdout.push(c.toString()); done(); } }),
    };
    const deps = { auth: { signInAppOnly }, store: { upsert } };
    return { deps, connection, signInAppOnly, upsert, io, input, stdout: () => stdout.join(""), stderr: () => stderr.join("") };
  }

  const args = { command: "connect-app-only" as const, tenantId: "t-1", clientId: "c-1", mode: "write" as const };

  it("prompts for the client secret on stderr and hands it to the sign-in, never to an argument", async () => {
    const f = fakes();
    const promise = connectAppOnly(f.deps as never, args, f.io);
    f.input.write("s3cret\n");
    await promise;

    expect(f.stderr()).toContain("Client secret: ");
    expect(f.signInAppOnly).toHaveBeenCalledWith({ tenantId: "t-1", clientId: "c-1", mode: "write", credential: "s3cret", certPath: undefined, alias: undefined });
    expect(JSON.stringify(args)).not.toContain("s3cret");
  });

  it("prompts for the certificate password instead when --cert is given", async () => {
    const f = fakes();
    const promise = connectAppOnly(f.deps as never, { ...args, certPath: "/tmp/app.pem" }, f.io);
    f.input.write("pw\n");
    await promise;

    expect(f.stderr()).toContain("Certificate password for /tmp/app.pem: ");
    expect(f.signInAppOnly).toHaveBeenCalledWith(expect.objectContaining({ certPath: "/tmp/app.pem", credential: "pw" }));
  });

  it("stores the connection", async () => {
    const f = fakes();
    const promise = connectAppOnly(f.deps as never, args, f.io);
    f.input.write("s3cret\n");
    await promise;

    expect(f.upsert).toHaveBeenCalledWith(f.connection);
  });

  it("confirms on stdout naming the alias, tenant, client id and mode, and never the secret", async () => {
    const f = fakes();
    const promise = connectAppOnly(f.deps as never, args, f.io);
    f.input.write("s3cret\n");
    await promise;

    expect(f.stdout()).toBe('Connected "contoso-app" (Contoso) as app c-1, mode write\n');
    expect(f.stdout()).not.toContain("s3");
  });

  it("stores nothing when the sign-in fails", async () => {
    const f = fakes();
    f.signInAppOnly.mockRejectedValueOnce(new Error("AADSTS7000215: Invalid client secret provided"));
    const promise = connectAppOnly(f.deps as never, args, f.io);
    f.input.write("wrong\n");

    await expect(promise).rejects.toThrow(/Invalid client secret/);
    expect(f.upsert).not.toHaveBeenCalled();
  });
});

describe("parseArgs for an agent connection (#72)", () => {
  const full = ["connect", "--agent", "--tenant", "t-1", "--blueprint-id", "bp-1", "--agent-id", "ag-1", "--cert", "/tmp/bp.pem", "--mode", "read", "--alias", "agent"];

  it("parses --agent with its flags", () => {
    expect(parseArgs(full)).toEqual({ command: "connect-agent", tenantId: "t-1", blueprintId: "bp-1", agentId: "ag-1", certPath: "/tmp/bp.pem", mode: "read", alias: "agent" });
  });

  it("rejects each missing required flag with its own message", () => {
    expect(() => parseArgs(["connect", "--agent", "--blueprint-id", "bp-1", "--agent-id", "ag-1", "--mode", "read"])).toThrow(AGENT_NEEDS_TENANT);
    expect(() => parseArgs(["connect", "--agent", "--tenant", "t-1", "--agent-id", "ag-1", "--mode", "read"])).toThrow(AGENT_NEEDS_IDS);
    expect(() => parseArgs(["connect", "--agent", "--tenant", "t-1", "--blueprint-id", "bp-1", "--mode", "read"])).toThrow(AGENT_NEEDS_IDS);
    expect(() => parseArgs(["connect", "--agent", "--tenant", "t-1", "--blueprint-id", "bp-1", "--agent-id", "ag-1"])).toThrow(AGENT_NEEDS_MODE);
  });

  it("rejects --agent with --app-only, and the agent flags without --agent", () => {
    expect(() => parseArgs([...full, "--app-only"])).toThrow(AGENT_REJECTS_APP_ONLY);
    expect(() => parseArgs(["connect", "--agent-id", "ag-1"])).toThrow("--agent-id is only used with --agent.");
    expect(() => parseArgs(["connect", "--blueprint-id", "bp-1"])).toThrow("--blueprint-id is only used with --agent.");
  });

  it("rejects --template and --scopes, because the agent's scopes come from its blueprint", () => {
    expect(() => parseArgs([...full, "--template", "read"])).toThrow(/blueprint/);
    expect(() => parseArgs([...full, "--scopes", "User.Read"])).toThrow(/blueprint/);
  });
});

describe("connectAgent (#72)", () => {
  function fakes() {
    const connection: Connection = {
      alias: "agent", tenantId: "t-1", tenantName: "Contoso", kind: "agent", mode: "read", clientId: "public",
      username: "admin@contoso.com", agentId: "ag-1", blueprintId: "bp-1", scopes: ["Directory.Read.All"], addedAt: "2026-10-01T00:00:00.000Z",
    };
    const signInAgent = vi.fn(async () => ({ connection }));
    const upsert = vi.fn(async () => {});
    const stdout: string[] = [];
    const stderr: string[] = [];
    const input = new PassThrough();
    const io = {
      input,
      output: new Writable({ write(c, _e, done) { stderr.push(c.toString()); done(); } }),
      stdout: new Writable({ write(c, _e, done) { stdout.push(c.toString()); done(); } }),
    };
    return { deps: { auth: { signInAgent }, store: { upsert } }, connection, signInAgent, upsert, io, input, stdout: () => stdout.join(""), stderr: () => stderr.join("") };
  }
  const args = { command: "connect-agent" as const, tenantId: "t-1", blueprintId: "bp-1", agentId: "ag-1", certPath: "/tmp/bp.pem", mode: "read" as const };

  it("prompts for the blueprint's certificate password and hands it to the sign-in", async () => {
    const f = fakes();
    const promise = connectAgent(f.deps as never, args, f.io);
    f.input.write("pw\n");
    await promise;

    expect(f.stderr()).toContain("Certificate password for /tmp/bp.pem: ");
    expect(f.signInAgent).toHaveBeenCalledWith({ tenantId: "t-1", blueprintId: "bp-1", agentId: "ag-1", mode: "read", credential: "pw", certPath: "/tmp/bp.pem", alias: undefined });
  });

  it("stores the connection and names the agent and the person", async () => {
    const f = fakes();
    const promise = connectAgent(f.deps as never, args, f.io);
    f.input.write("pw\n");
    await promise;

    expect(f.upsert).toHaveBeenCalledWith(f.connection);
    expect(f.stdout()).toBe('Connected "agent" (Contoso) as agent ag-1 for admin@contoso.com, mode read\n');
  });

  it("stores nothing when the sign-in fails", async () => {
    const f = fakes();
    f.signInAgent.mockRejectedValueOnce(new Error("AADSTS700027"));
    const promise = connectAgent(f.deps as never, args, f.io);
    f.input.write("pw\n");

    await expect(promise).rejects.toThrow(/700027/);
    expect(f.upsert).not.toHaveBeenCalled();
  });
});

describe("isEntryPoint (#63)", () => {
  it("is true when the bin is started through the symlink npm and npx create", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const dir = mkdtempSync(join(tmpdir(), "bin-"));
    const real = join(dir, "main.js");
    const link = join(dir, "graphslayer");
    writeFileSync(real, "");
    symlinkSync(real, link);

    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
    expect(isEntryPoint(real, pathToFileURL(real).href)).toBe(true);
    expect(isEntryPoint(join(dir, "other.js"), pathToFileURL(real).href)).toBe(false);
    expect(isEntryPoint(undefined, pathToFileURL(real).href)).toBe(false);
  });
});
