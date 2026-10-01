import { describe, it, expect } from "vitest";
import type { Connection } from "../src/core/types.js";

describe("scaffold", () => {
  it("compiles shared types", () => {
    const c: Connection = {
      alias: "contoso",
      tenantId: "00000000-0000-0000-0000-000000000001",
      kind: "delegated",
      clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
      scopes: ["User.Read"],
      addedAt: new Date().toISOString(),
    };
    expect(c.alias).toBe("contoso");
  });
});
