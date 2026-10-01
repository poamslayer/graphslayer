import { describe, it, expect } from "vitest";
import { buildRequestUrl, needsConsistency, validatePath, encodeCursor, decodeCursor } from "../../../src/core/graph/query.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com";

describe("validatePath", () => {
  it("accepts a normal relative path", () => {
    expect(() => validatePath("/users")).not.toThrow();
    expect(() => validatePath("/users/abc/memberOf")).not.toThrow();
  });
  it("accepts a user principal name in the path", () => {
    expect(() => validatePath("/users/admin@contoso.com")).not.toThrow();
  });
  it("rejects absolute urls, traversal, and odd characters", () => {
    expect(() => validatePath("https://evil.example/users")).toThrow();
    expect(() => validatePath("users")).toThrow();
    expect(() => validatePath("/users/../me")).toThrow();
    expect(() => validatePath("//evil.example/users")).toThrow();
    expect(() => validatePath("/users?x=1")).toThrow();
    expect(() => validatePath("/users#x")).toThrow();
  });
});

describe("buildRequestUrl", () => {
  it("builds v1.0 by default and percent-encodes odata values", () => {
    const url = buildRequestUrl(GRAPH_ORIGIN, "/users", { select: ["id", "displayName"], top: 5 });
    expect(url).toBe("https://graph.microsoft.com/v1.0/users?$select=id%2CdisplayName&$top=5");
  });
  it("encodes spaces as %20, not +", () => {
    const url = buildRequestUrl(GRAPH_ORIGIN, "/users", { filter: "accountEnabled eq true" });
    expect(url).toContain("$filter=accountEnabled%20eq%20true");
  });
  it("uses beta when asked", () => {
    expect(buildRequestUrl(GRAPH_ORIGIN, "/users", { beta: true })).toBe("https://graph.microsoft.com/beta/users");
  });
  it("adds $count=true when consistency is needed", () => {
    const url = buildRequestUrl(GRAPH_ORIGIN, "/users", { filter: "endsWith(mail,'x')" });
    expect(url).toContain("$count=true");
  });
});

describe("needsConsistency", () => {
  it("is true for advanced queries on directory objects", () => {
    expect(needsConsistency("/users", { filter: "x" })).toBe(true);
    expect(needsConsistency("/groups/1/members", { search: "x" })).toBe(true);
    expect(needsConsistency("/servicePrincipals", { orderby: "displayName" })).toBe(true);
  });
  it("is false for plain reads and for non-directory paths", () => {
    expect(needsConsistency("/users", {})).toBe(false);
    expect(needsConsistency("/me/messages", { filter: "isRead eq false" })).toBe(false);
  });
});

describe("needsConsistency reading the index", () => {
  /** Stands in for the index: true where Microsoft marks the path, undefined everywhere else. */
  const marked = (...paths: string[]) => (path: string) => (paths.includes(path) ? (true as const) : undefined);
  const nothingMarked = () => undefined;

  it("sets the header for a path the index marks that the old list never covered", () => {
    // 97 v1.0 paths carry Microsoft's marker and are outside plan 1's list, 75 of them under /me.
    expect(needsConsistency("/me/memberOf", { filter: "x" }, marked("/me/memberOf"))).toBe(true);
    expect(needsConsistency("/directory/deletedItems", { search: "x" }, marked("/directory/deletedItems"))).toBe(true);
  });

  it("still asks for a real advanced query before setting the header", () => {
    expect(needsConsistency("/me/memberOf", {}, marked("/me/memberOf"))).toBe(false);
    expect(needsConsistency("/me/memberOf", { select: ["id"] }, marked("/me/memberOf"))).toBe(false);
  });

  it("falls back to the old rule for a path the index does not mark", () => {
    // An absent marker means Microsoft did not mark the path, not that the header is unneeded.
    // Dropping it here would turn a working advanced query into a Graph error.
    expect(needsConsistency("/users", { filter: "x" }, nothingMarked)).toBe(true);
    expect(needsConsistency("/groups/1/members", { search: "x" }, nothingMarked)).toBe(true);
    expect(needsConsistency("/me/messages", { filter: "x" }, nothingMarked)).toBe(false);
  });

  it("falls back the same way for a path the index has no entry for at all", () => {
    expect(needsConsistency("/users/1/somethingTheIndexMissed", { filter: "x" }, nothingMarked)).toBe(true);
    expect(needsConsistency("/somewhereElse", { filter: "x" }, nothingMarked)).toBe(false);
  });

  it("no longer sets the header on /directoryRoles", () => {
    // Microsoft documents $select, $filter (eq only) and $expand there and nothing else: no
    // $count, no $search, no $orderby, no ConsistencyLevel. Plan 1's list was overbroad, and
    // the $count=true it added is a query option that path does not take.
    expect(needsConsistency("/directoryRoles", { filter: "displayName eq 'Global Administrator'" })).toBe(false);
    expect(needsConsistency("/directoryRoles", { filter: "x" }, nothingMarked)).toBe(false);
  });
});

describe("cursor", () => {
  it("round trips a graph next link and rejects other hosts", () => {
    const link = "https://graph.microsoft.com/v1.0/users?$skiptoken=abc";
    expect(decodeCursor(GRAPH_ORIGIN, encodeCursor(link))).toBe(link);
    expect(() => decodeCursor(GRAPH_ORIGIN, encodeCursor("https://evil.example/x"))).toThrow();
    expect(() => decodeCursor(GRAPH_ORIGIN, "not-base64!")).toThrow();
  });
});

describe("connection graph origin", () => {
  it("builds URLs and accepts cursors only for the origin passed by the connection", () => {
    const origin = "https://graph.microsoft.us";
    const link = "https://graph.microsoft.us/v1.0/users?$skiptoken=abc";

    expect(buildRequestUrl(origin, "/users", { beta: true })).toBe("https://graph.microsoft.us/beta/users");
    expect(decodeCursor(origin, encodeCursor(link))).toBe(link);
    expect(() => decodeCursor(origin, encodeCursor("https://graph.microsoft.com/v1.0/users?$skiptoken=abc"))).toThrow();
  });
});
