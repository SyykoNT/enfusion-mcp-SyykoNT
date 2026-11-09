import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiagnosticReport, WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbDiagnose } from "../../src/tools/wb-diagnose.js";

// No real process query and no real watch folder: both come from the stubs below.
const report: DiagnosticReport = {
  host: "127.0.0.1", port: 5775, workbenchExe: null, projectPath: null, defaultMod: "DefaultMod",
  bundledScripts: { path: "b", exists: true }, standaloneAddon: { path: "s", exists: false, fileCount: 0 },
  installedMods: [{ modDir: "projects/DefaultMod", handlerDir: "projects/DefaultMod/Scripts/WorkbenchGame/EnfusionMCP", fileCount: 22 }],
  netApi: "up_with_handlers",
};

async function run(workbenches: { pid: number; gproj: string }[], watchDir = mkdtempSync(join(tmpdir(), "emcp-diag-watch-"))) {
  let h!: () => Promise<{ content: { text: string }[] }>;
  const server = { registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer;
  registerWbDiagnose(server, { diagnose: async () => report } as unknown as WorkbenchClient, { workbenches: () => workbenches, watchDir });
  return (await h()).content[0].text;
}

describe("wb_diagnose", () => {
  it("names the handler folder of the addon the running Workbench loaded, from its -gproj, not only the default mod's", async () => {
    const addon = mkdtempSync(join(tmpdir(), "emcp-diag-addon-"));
    const dir = join(addon, "Scripts", "WorkbenchGame", "EnfusionMCP");
    mkdirSync(dir, { recursive: true });
    for (const f of ["EMCP_WB_Ping.c", "EMCP_WB_GetState.c", "Other.c"]) writeFileSync(join(dir, f), "");
    const text = await run([{ pid: 6216, gproj: join(addon, "addon.gproj") }]);
    expect(text).toContain(`**Loaded addon (PID 6216, from its -gproj):** 2 .c files → \`${dir}\``);
    expect(text).toContain("projects/DefaultMod/Scripts/WorkbenchGame/EnfusionMCP");
  });

  it("says so when no Workbench runs, when its command line has no -gproj, or when the loaded addon has no handlers", async () => {
    expect(await run([])).toContain("**Loaded addon:** no running Workbench found");
    expect(await run([{ pid: 7, gproj: "" }])).toContain("**Loaded addon:** PID 7 has no -gproj");
    expect(await run([{ pid: 8, gproj: join(tmpdir(), "emcp-diag-missing", "addon.gproj") }])).toContain("no handler files");
  });

  it("lists exited watchers only for the newest few and counts the rest; live ones always", async () => {
    const watchDir = mkdtempSync(join(tmpdir(), "emcp-diag-watch-"));
    const put = (pid: number, state: string, updated: number) =>
      writeFileSync(join(watchDir, `${pid}.json`), JSON.stringify({ pid, watcherPid: 1, owned: false, state, since: updated, lastLines: [], actions: [], dismiss: "watched", autoRecover: false, updated }));
    put(100, "ok", 1000);
    for (let i = 0; i < 25; i++) put(200 + i, "exited", 2000 + i);
    const text = await run([], watchDir);
    expect(text).toContain("Workbench PID 100 (not owned): OK");
    expect(text.match(/Workbench PID \d+ \(/g)).toHaveLength(4);
    expect(text).toContain("Workbench PID 224 (");
    expect(text).not.toContain("Workbench PID 221 (");
    expect(text).toContain("- and 22 older finished watchers (exited or crashed) not shown");
  });
});
