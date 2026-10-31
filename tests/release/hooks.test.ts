import { describe, it, expect } from "vitest";
import { COMMIT_MSG, DON_COMMIT_MSG, GUARDED_PATH, HOOK_VERSION, PRE_COMMIT, ourVersion } from "../../src/release/hooks.js";

describe("hook templates", () => {
  it("carry our marker and version", () => {
    expect(ourVersion(PRE_COMMIT)).toBe(HOOK_VERSION);
    expect(ourVersion(COMMIT_MSG)).toBe(HOOK_VERSION);
    expect(ourVersion(DON_COMMIT_MSG)).toBeNull();
    expect(ourVersion("#!/bin/sh\n# enfusion-mcp-syykont commit guard v0 (old)\n")).toBe(0);
  });

  it("are LF only, without a BOM, and use no tool GitHub Desktop's Git lacks", () => {
    for (const t of [PRE_COMMIT, COMMIT_MSG]) {
      expect(t).not.toContain("\r");
      expect(t.charCodeAt(0)).not.toBe(0xfeff);
      expect(t.startsWith("#!/bin/sh\n")).toBe(true);
      expect(t).not.toMatch(/\bod\b|mktemp|TMPDIR/);
    }
    expect(PRE_COMMIT).toContain(GUARDED_PATH);
  });

  it("guards handler files, the folder .meta and the rdb, not look-alikes", () => {
    const g = new RegExp(GUARDED_PATH);
    expect(["Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", "Scripts/WorkbenchGame/EnfusionMCP.meta", "resourceDatabase.rdb", "a/resourceDatabase.rdb"].every((p) => g.test(p))).toBe(true);
    expect(["Scripts/WorkbenchGame/EnfusionMCPX/a.c", "Scripts/Game/EnfusionMCP/a.c", "x/Scripts/WorkbenchGame/EnfusionMCP/a.c"].some((p) => g.test(p))).toBe(false);
  });
});
