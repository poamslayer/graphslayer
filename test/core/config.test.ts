import { describe, it, expect } from "vitest";
import { cloudEndpoints, resolveConfig, DEFAULT_CLIENT_ID } from "../../src/core/config.js";

describe("cloudEndpoints", () => {
  it("maps the shipped clouds and treats an absent cloud as commercial", () => {
    expect(cloudEndpoints(undefined)).toEqual({
      graphOrigin: "https://graph.microsoft.com",
      graphScopeDefault: "https://graph.microsoft.com/.default",
      authorityBase: "https://login.microsoftonline.com",
    });
    expect(cloudEndpoints("commercial")).toEqual(cloudEndpoints(undefined));
    expect(cloudEndpoints("usgov-high")).toEqual({
      graphOrigin: "https://graph.microsoft.us",
      graphScopeDefault: "https://graph.microsoft.us/.default",
      authorityBase: "https://login.microsoftonline.us",
    });
  });
});

describe("resolveConfig", () => {
  it("uses the home directory by default", () => {
    const cfg = resolveConfig({ HOME: "/Users/test" });
    expect(cfg.homeDir).toBe("/Users/test/.graphslayer");
    expect(cfg.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(cfg.tokenCacheEnabled).toBe(true);
  });

  it("honours env overrides", () => {
    const cfg = resolveConfig({
      HOME: "/Users/test",
      GRAPHSLAYER_HOME: "/tmp/x",
      GRAPHSLAYER_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
      GRAPHSLAYER_NO_TOKEN_CACHE: "1",
    });
    expect(cfg.homeDir).toBe("/tmp/x");
    expect(cfg.clientId).toBe("11111111-1111-1111-1111-111111111111");
    expect(cfg.tokenCacheEnabled).toBe(false);
  });
});
