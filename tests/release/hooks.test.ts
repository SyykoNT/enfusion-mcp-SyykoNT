import { describe, it, expect } from "vitest";
import { COMMIT_MSG, STRIPPER_COMMIT_MSG, GUARDED_PATH, HOOK_VERSION, PRE_COMMIT, ourVersion } from "../../src/release/hooks.js";

describe("hook templates", () => {
  it("carry our marker and version", () => {
    expect(ourVersion(PRE_COMMIT)).toBe(HOOK_VERSION);
    expect(ourVersion(COMMIT_MSG)).toBe(HOOK_VERSION);
    expect(ourVersion(STRIPPER_COMMIT_MSG)).toBeNull();
    expect(ourVersion("#!/bin/sh\n# enfusion-mcp-syykont commit guard v0 (old)\n")).toBe(0);
  });

  it("are LF only, without a BOM, and use no tool GitHub Desktop's Git lacks", () => {
    for (const t of [PRE_COMMIT, COMMIT_MSG]) {
      expect(t).not.toContain("\r");
      expect(t.charCodeAt(0)).not.toBe(0xfeff);
      expect(t.startsWith("#!/bin/sh\n")).toBe(true);
      expect(t).not.toMatch(/\bod\b|mktemp|TMPDIR/);
    }
    expect(PRE_COMMIT).toContain(`grep -iE '${GUARDED_PATH}'`);
    expect(PRE_COMMIT).toContain("only with the user's OK");
  });

  it("guards handler files, the folder .meta and the rdb, not look-alikes", () => {
    const g = new RegExp(GUARDED_PATH, "i");
    expect(["Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", "Scripts/WorkbenchGame/EnfusionMCP.meta", "resourceDatabase.rdb", "a/resourceDatabase.rdb", "scripts/workbenchgame/enfusionmcp/x.c", "SCRIPTS/WorkbenchGame/EnfusionMCP.META", "ResourceDatabase.RDB"].every((p) => g.test(p))).toBe(true);
    expect(["Scripts/WorkbenchGame/EnfusionMCPX/a.c", "Scripts/Game/EnfusionMCP/a.c", "x/Scripts/WorkbenchGame/EnfusionMCP/a.c"].some((p) => g.test(p))).toBe(false);
  });
});
