import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { findWorkbenchExe, findGproj } from "../utils/game-paths.js";
import { findPids, serverProcesses, clientProcesses } from "../utils/process.js";
import { crashLogsFolder } from "../workbench/cli.js";
import { peFileVersion } from "../utils/pe-version.js";
import { gameGuidMap } from "../pak/rdb.js";
import type { WorkbenchClient } from "../workbench/client.js";

export interface BuildInfo { version: string; commit: string; builtAt: string }

const BUILD_INFO_FILE = fileURLToPath(new URL("../build-info.json", import.meta.url));

// dist/build-info.json is written by scripts/build-info.mjs; missing or broken means an unstamped build.
export function readBuildInfo(file = BUILD_INFO_FILE): BuildInfo | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof j.version === "string" && typeof j.commit === "string" && typeof j.builtAt === "string") return j;
  } catch { /* unstamped build */ }
  return undefined;
}

const packageVersion = (): string => createRequire(import.meta.url)("../../package.json").version;

// Read once at load: a rebuild over a live dist must not change what this process reports.
export const buildInfo = readBuildInfo();

export const serverVersion = (info: BuildInfo | undefined): string => (info ? `${info.version}+${info.commit}` : packageVersion());

export function registerEnvCheck(server: McpServer, config: Config, client: WorkbenchClient): void {
  server.registerTool(
    "env_check",
    {
      description:
        "Health check of the whole modding setup: game, Arma Reforger Tools (Workbench Diag exe), dedicated server, SteamCMD, " +
        "project/packed/profile folders, running processes, Workbench NET API, game version and resource database, with the " +
        "fix for anything missing. Paths come from the ENFUSION_* environment variables (or ~/.enfusion-mcp/config.json, edited by hand). Run this first on a new machine.",
      inputSchema: {},
    },
    async () => {
      const ok = (b: boolean) => (b ? "✅" : "❌");
      const unstamped = existsSync(BUILD_INFO_FILE) ? "build-info.json unreadable" : "no build-info.json: built without scripts/build-info.mjs";
      const lines: string[] = ["## Environment", "", buildInfo ? `- MCP build: ${serverVersion(buildInfo)}, built ${buildInfo.builtAt}` : `- MCP build: ${packageVersion()} (${unstamped})`];
      const gameExe = join(config.gamePath, "ArmaReforgerSteam.exe");
      const gameDiag = join(config.gamePath, "ArmaReforgerSteamDiag.exe");
      const wbExe = findWorkbenchExe(config.workbenchPath);
      const serverExe = join(config.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer");
      const steamcmd = join(config.steamcmdPath, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh");

      const ver = (exe: string) => { const v = peFileVersion(exe); return v ? ` (v${v})` : ""; };
      const crash = crashLogsFolder(config);
      const crashLine = crash.refused
        ? `${ok(false)} Crash logs folder: ENFUSION_CRASH_LOGS_DIR (crashLogsDir) "${crash.refused.setting}" is refused, it is inside ${crash.refused.root}; ${crash.dir ? `using ${crash.dir}` : "no crash logs folder is set"}`
        : `${ok(!!crash.dir)} Crash logs folder: ${crash.dir ?? "none (its default location is not allowed): set ENFUSION_CRASH_LOGS_DIR"}`;

      lines.push(
        `${ok(existsSync(gameExe))} Game: ${config.gamePath}${ver(gameExe)}`,
        `${ok(existsSync(gameDiag))} Game Diag exe (needed for game launch connect/world)`,
        `${ok(!!wbExe)} Workbench: ${wbExe ?? `${config.workbenchPath}: install "Arma Reforger Tools" from Steam`}`,
        `${ok(existsSync(serverExe))} Dedicated server: ${existsSync(serverExe) ? `${config.serverPath}${ver(serverExe)}` : "not installed: `server install`"}`,
        `${ok(existsSync(steamcmd))} SteamCMD: ${existsSync(steamcmd) ? config.steamcmdPath : "not downloaded (server install does it)"}`,
        crashLine,
      );
      let guidCount = 0;
      try { guidCount = gameGuidMap(config.gamePath).size; } catch { /* ignore */ }
      lines.push(`${ok(guidCount > 0)} Base-game resource database: ${guidCount} resources with GUIDs`);

      const addons = existsSync(config.projectPath)
        ? readdirSync(config.projectPath, { withFileTypes: true }).filter((e) => e.isDirectory() && findGproj(join(config.projectPath, e.name))).map((e) => e.name)
        : [];
      lines.push(
        "",
        `${ok(existsSync(config.projectPath))} Addons (projectPath): ${config.projectPath}: ${addons.length} addon(s)${addons.length ? `: ${addons.slice(0, 15).join(", ")}` : ""}`,
        `- Packed builds: ${config.packedPath}${existsSync(config.packedPath) ? ` (${readdirSync(config.packedPath).length})` : " (created on first build)"}`,
        `- Server profile: ${config.serverProfilePath}`,
        "",
        "## Running",
        `- Workbench: ${findPids("ArmaReforgerWorkbenchSteamDiag.exe").length ? "yes" : "no"} · NET API: ${(await client.ping()) ? "responding" : "not reachable"} (${config.workbenchHost}:${config.workbenchPort})`,
        `- Game: ${clientProcesses().length ? "yes" : "no"}`,
        `- Dedicated server: ${serverProcesses().length ? "yes" : "no"}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
