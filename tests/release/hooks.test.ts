import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripLines } from "../../src/release/ai-attribution.js";
import { AI_SAMPLES, HUMAN_LINES } from "./ai-samples.js";
import { COMMIT_MSG, STRIPPER_COMMIT_MSG, GUARDED_PATH, HOOK_VERSION, PRE_COMMIT, ourVersion } from "../../src/release/hooks.js";

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

describe("hook templates", () => {
  it("are v4, and the older user stripper text is unchanged (it only detects hooks other people wrote)", () => {
    expect(HOOK_VERSION).toBe(4);
    expect(ourVersion(COMMIT_MSG)).toBe(4);
    expect(STRIPPER_COMMIT_MSG).toBe(
      "#!/bin/sh\n# Local hook (not tracked): strip Claude/Anthropic attribution lines from commit messages.\n" +
        'sed -i -E "/^[Cc]o-[Aa]uthored-[Bb]y:.*([Cc]laude|[Aa]nthropic)/d; /[Gg]enerated with \\[?[Cc]laude [Cc]ode/d; /^[Cc]laude-[Ss]ession:/d" "$1"\n' +
        "# drop trailing blank lines left behind\n" +
        'sed -i -e :a -e "/^\\n*\\$/{\\$d;N;ba" -e "}" "$1"\n'
    );
  });

  it.skipIf(!hasSh)("the generated commit-msg hook leaves exactly what stripLines leaves (parity with the TS list)", () => {
    const dir = mkdtempSync(join(tmpdir(), "emcp-hookparity-"));
    const hook = join(dir, "commit-msg");
    writeFileSync(hook, COMMIT_MSG);
    const msg = ["Subject line", "", "Body text", "", ...AI_SAMPLES.map((s) => s.line), ...HUMAN_LINES, "", "last line"].join("\n");
    const file = join(dir, "MSG");
    writeFileSync(file, msg + "\n");
    const r = spawnSync("sh", [hook, file], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    const out = readFileSync(file, "utf-8");
    expect(out.replace(/\n+$/, "")).toBe(stripLines(msg).replace(/\n+$/, ""));
    for (const s of AI_SAMPLES) expect(out.includes(s.line), s.line).toBe(!s.strip);
    for (const l of HUMAN_LINES) expect(out.includes(l), l).toBe(true);
  });

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
