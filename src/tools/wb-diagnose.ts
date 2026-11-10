import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { WATCH_DIR, formatReport, olderLine, readStates, recentStates } from "../watchdog/wb-watch.js";
import { workbenchCommandLines } from "../utils/process.js";

export interface DiagnoseDeps {
  /** Running Workbench processes with the -gproj of each. */
  workbenches(): { pid: number; gproj: string }[];
  watchDir: string;
}

/** The handler folder of each addon a local Workbench loaded, from the -gproj on its command line (the Default Mod is only where wb_launch injects). */
function loadedAddonLines(deps: DiagnoseDeps): string[] {
  const list = deps.workbenches();
  if (!list.length) return ["- **Loaded addon:** no local Workbench found, so no -gproj to read"];
  return list.map(({ pid, gproj }) => {
    if (!gproj) return `- **Loaded addon:** local PID ${pid} has no -gproj on its command line`;
    // shortcut: the process list gives no working folder, so a relative -gproj stays unresolved.
    if (!isAbsolute(gproj)) return `- **Loaded addon:** local PID ${pid} has a relative -gproj (\`${gproj}\`), unresolved because its working folder is not known`;
    const dir = join(dirname(gproj), "Scripts", "WorkbenchGame", "EnfusionMCP");
    try {
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("EMCP_") && f.endsWith(".c")).length : 0;
      return `- **Loaded addon (local PID ${pid}, from its -gproj):** ${files ? `${files} .c files` : "no handler files"} → \`${dir}\``;
    } catch (e) {
      return `- **Loaded addon:** cannot read \`${dir}\` for local PID ${pid} (${(e as NodeJS.ErrnoException).code ?? "error"})`;
    }
  });
}

export function registerWbDiagnose(
  server: McpServer,
  client: WorkbenchClient,
  deps: DiagnoseDeps = { workbenches: workbenchCommandLines, watchDir: WATCH_DIR }
): void {
  server.registerTool(
    "wb_diagnose",
    {
      description:
        "Run a full diagnostic of the EnfusionMCP ↔ Workbench connection. " +
        "Reports config, handler script locations, and NET API status without auto-launching Workbench. " +
        "Use this when wb_launch fails or wb_connect returns errors.",
      inputSchema: {},
    },
    async () => {
      const r = await client.diagnose();

      const lines: string[] = ["## EnfusionMCP Diagnostic Report\n"];

      // --- Config ---
      lines.push("### Configuration");
      lines.push(`- **NET API:** ${r.host}:${r.port}`);
      if (r.workbenchExe) {
        const mark = r.workbenchExe.exists ? "FOUND" : "NOT FOUND";
        lines.push(`- **Workbench Exe:** ${mark}, \`${r.workbenchExe.path}\``);
      } else {
        lines.push("- **Workbench Exe:** config not loaded");
      }
      if (r.projectPath) {
        const mark = r.projectPath.exists ? "EXISTS" : "NOT FOUND";
        lines.push(`- **Project Path:** ${mark}, \`${r.projectPath.path}\``);
      } else {
        lines.push("- **Project Path:** not configured");
      }
      lines.push(`- **Default Mod:** ${r.defaultMod ?? "(not set)"}`);

      // --- Handler Scripts ---
      lines.push("\n### Handler Scripts");
      {
        const mark = r.bundledScripts.exists ? "FOUND" : "MISSING";
        lines.push(`- **Bundled source:** ${mark}, \`${r.bundledScripts.path}\``);
      }
      {
        const mark = r.standaloneAddon.exists
          ? `EXISTS (${r.standaloneAddon.fileCount} .c files), should be absent when injecting into a mod`
          : "not present (correct)";
        lines.push(`- **Standalone addon:** ${mark}, \`${r.standaloneAddon.path}\``);
      }
      lines.push(...loadedAddonLines(deps));
      if (r.installedMods.length === 0) {
        lines.push("- **Installed in mods:** none found, handlers not injected into any mod");
      } else {
        for (const m of r.installedMods) {
          lines.push(`- **Installed:** ${m.fileCount} .c files → \`${m.handlerDir}\``);
        }
      }

      // --- NET API ---
      lines.push("\n### NET API Connection");
      switch (r.netApi) {
        case "up_with_handlers":
          lines.push(`- **Status:** CONNECTED. EMCP_WB_Ping responded. ${(await client.worldStaleLine("EMCP_WB_GetState", {})) ? "Tools that read World Editor state are refused: a refused open left the world unstable. Open a world with wb_open_resource (a .ent) or restart Workbench." : "All wb_* tools are available."}`);
          break;
        case "up_no_handlers":
          lines.push("- **Status:** PORT OPEN, HANDLERS NOT LOADED");
          lines.push("  - Workbench NET API is reachable but EMCP_WB_Ping is not registered.");
          lines.push("  - Handler scripts were not compiled. Check:");
          lines.push("    1. Are handlers installed in the mod listed above?");
          lines.push("    2. Does that mod have script errors preventing compilation?");
          lines.push("    3. Is Workbench open with that mod's .gproj loaded?");
          if (r.netApiError) lines.push(`  - Raw error: \`${r.netApiError}\``);
          break;
        case "refused":
          lines.push("- **Status:** CONNECTION REFUSED. Workbench is not running or NET API is disabled.");
          lines.push("  - Start Workbench and enable NET API: File > Options > General > Net API");
          if (r.netApiError) lines.push(`  - Raw error: \`${r.netApiError}\``);
          break;
        case "timeout":
          lines.push("- **Status:** TIMEOUT. Connection hung. Possible firewall or port conflict.");
          if (r.netApiError) lines.push(`  - Raw error: \`${r.netApiError}\``);
          break;
        case "error":
          lines.push("- **Status:** ERROR");
          if (r.netApiError) lines.push(`  - Raw error: \`${r.netApiError}\``);
          break;
      }

      // --- Recommendations ---
      const problems: string[] = [];
      if (!r.bundledScripts.exists) {
        problems.push("Bundled handler scripts are missing from the package installation. Re-install enfusion-mcp.");
      }
      if (r.standaloneAddon.exists && r.installedMods.length > 0) {
        problems.push(
          "A standalone addon AND mod-injected handlers coexist: this causes duplicate class errors. " +
            "Run wb_launch to clean up the standalone addon automatically, or delete it manually: " +
            `\`${r.standaloneAddon.path}\``
        );
      }
      if (r.netApi === "up_no_handlers" && r.installedMods.length === 0) {
        problems.push(
          "NET API is up but no handler scripts are installed anywhere. " +
            "Call wb_launch with a gprojPath to inject handlers into the correct mod."
        );
      }

      if (problems.length > 0) {
        lines.push("\n### Issues Detected");
        for (const p of problems) {
          lines.push(`- ${p}`);
        }
      }

      // --- Watchdog ---
      const watch = readStates(deps.watchDir);
      const { shown, hidden } = recentStates(watch.states);
      lines.push("\n### Watchdog");
      if (!watch.states.length && !watch.errors.length) lines.push("- No Workbench is watched. The next live call attaches a watcher to the Workbench on the NET API port unless ENFUSION_WB_AUTOWATCH is off; wb_watch start pid=<n> attaches one now.");
      for (const s of shown) lines.push("```", formatReport(s), "```");
      if (hidden) lines.push(`- ${olderLine(hidden)}`);
      for (const e of watch.errors) lines.push(`- ${e}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
