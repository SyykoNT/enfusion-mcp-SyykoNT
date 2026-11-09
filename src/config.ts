import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";
import { myGamesDir } from "./utils/game-paths.js";

export interface Config {
  /** Path to "Arma Reforger Tools" installation */
  workbenchPath: string;
  /** Default project directory for project_browse */
  projectPath: string;
  /** Path to base game installation (auto-derived from workbenchPath) */
  gamePath: string;
  /** Optional path to a pre-extracted game data library (fully flattened prefabs).
   *  When set, game_duplicate checks here first before falling back to pak loose files.
   *  Set via ENFUSION_EXTRACTED_PATH env var. */
  extractedPath?: string;
  /** Directory containing scraped data index */
  dataDir: string;
  /** Directory containing mod pattern definitions */
  patternsDir: string;
  /** Workbench NET API host (default 127.0.0.1) */
  workbenchHost: string;
  /** Workbench NET API port (default 5775) */
  workbenchPort: number;
  /** Default addon folder name used when modName is not specified in tool calls.
   *  Automatically set at runtime when wb_launch opens a .gproj file.
   *  Can also be set via ENFUSION_DEFAULT_MOD env var as a static fallback. */
  defaultMod?: string;
  /** Arma Reforger Dedicated Server install dir (contains ArmaReforgerServer.exe). */
  serverPath: string;
  /** Directory holding steamcmd.exe (downloaded on demand by `server install`). */
  steamcmdPath: string;
  /** Server profile dir (saves, logs, downloaded workshop mods). */
  serverProfilePath: string;
  /** Where `game launch` records the clients it started. Set via ENFUSION_CLIENT_PROFILES. */
  clientProfilesRoot: string;
  /** Where `mod build` writes packed addons (each in <dir>/<AddonName>). */
  packedPath: string;
  /** Passed to Workbench as -addonsDir (comma-separated) on GUI and headless launches, so
   *  dependencies resolve from local clones. Set via ENFUSION_ADDONS_DIR. */
  addonsDir?: string;
  /** Addons no tool may write into, by .gproj GUID, ID or folder name. Set via ENFUSION_PROTECTED_ADDONS (comma-separated). */
  protectedAddons?: string[];
  /** GitHub users or orgs whose repos addon_git_guard install treats as the user's own. Set via ENFUSION_GITHUB_OWNERS (comma-separated). */
  githubOwners?: string[];
  /** Workshop download cache the addon stack reads (read only). Set via ENFUSION_WORKSHOP_PATH. */
  workshopPath?: string;
  /** Extra folders log_watch may read logs under. Set via ENFUSION_LOG_ROOTS (comma-separated). */
  logRoots?: string[];
  /** Register the nine COALITION mission-making tools. Off unless ENFUSION_COALITION_TOOLS is on, 1 or true. */
  coalitionTools?: boolean;
  /** How the watchdog answers "Script Authorization Required": rules (default), all (Yes to All) or off. Set via ENFUSION_SCRIPT_AUTH. */
  scriptAuth?: AuthMode;
  /** Where the log files of a crashed Workbench are copied. Set via ENFUSION_CRASH_LOGS_DIR; default: "Workbench Crash Logs" beside the Workbench profile folder. */
  crashLogsDir?: string;
  /** Attach a watcher by itself to the Workbench on the NET API port, whoever started it. On unless ENFUSION_WB_AUTOWATCH is off; set only by loadConfig. */
  autoWatch?: boolean;
}

/** A setting value as on or off: unset or on, 1, true, yes (any case) is on; off, 0, false, no is off; anything else is off, with the value in `invalid`. */
export function parseAutoWatch(value: unknown): { on: boolean; invalid?: string } {
  if (value === undefined || value === null || value === "") return { on: true };
  const v = String(value).trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return { on: true };
  return ["off", "0", "false", "no"].includes(v) ? { on: false } : { on: false, invalid: String(value) };
}
let autoWatchWarned = false;

export type AuthMode = "rules" | "all" | "off";

/** A setting value as a mode: rules, all or off in any case; anything else gives rules, with the value in `invalid`. */
export function parseAuthMode(value: unknown): { mode: AuthMode; invalid?: string } {
  if (value === undefined || value === null || value === "") return { mode: "rules" };
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "rules" || v === "all" || v === "off" ? { mode: v } : { mode: "rules", invalid: String(value) };
}
let authWarned = false;

const DEFAULT_WORKBENCH_PATH =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools";

export const MCP_HOME = join(homedir(), ".enfusion-mcp");

const STEAM_SERVER_PATH = resolve(DEFAULT_WORKBENCH_PATH, "..", "Arma Reforger Server");

const DEFAULTS: Config = {
  workbenchPath: DEFAULT_WORKBENCH_PATH,
  serverPath: existsSync(join(STEAM_SERVER_PATH, "ArmaReforgerServer.exe")) ? STEAM_SERVER_PATH : join(MCP_HOME, "server"),
  steamcmdPath: join(MCP_HOME, "steamcmd"),
  serverProfilePath: join(MCP_HOME, "server-profile"),
  clientProfilesRoot: join(MCP_HOME, "client-profiles"),
  packedPath: join(myGamesDir(), "ArmaReforgerWorkbench", "packed"),
  workshopPath: join(myGamesDir(), "ArmaReforger", "addons"),
  projectPath: join(myGamesDir(), "ArmaReforgerWorkbench", "addons"),
  gamePath: resolve(DEFAULT_WORKBENCH_PATH, "..", "Arma Reforger"),
  dataDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data"
  ),
  patternsDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
    "patterns"
  ),
  workbenchHost: "127.0.0.1",
  workbenchPort: 5775,
};

function loadJsonFile(path: string): Partial<Config> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<Config>;
  } catch (e) {
    // Distinguish read errors from parse errors so users can fix malformed JSON
    const detail = e instanceof SyntaxError
      ? `invalid JSON: ${e.message}`
      : String(e);
    logger.warn(`Failed to load config from ${path}: ${detail}`);
  }
  return {};
}

export function loadConfig(): Config {
  // 1. Start with defaults
  const config = { ...DEFAULTS };

  // 2. Package-local config file
  const localConfigPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "enfusion-mcp.config.json"
  );
  Object.assign(config, loadJsonFile(localConfigPath));

  // 3. User home config
  const homeConfigPath = resolve(homedir(), ".enfusion-mcp", "config.json");
  Object.assign(config, loadJsonFile(homeConfigPath));

  // 4. Environment variables override everything
  if (process.env.ENFUSION_WORKBENCH_PATH) {
    config.workbenchPath = process.env.ENFUSION_WORKBENCH_PATH;
  }
  if (process.env.ENFUSION_PROJECT_PATH) {
    config.projectPath = process.env.ENFUSION_PROJECT_PATH;
  }
  if (process.env.ENFUSION_GAME_PATH) {
    config.gamePath = process.env.ENFUSION_GAME_PATH;
  }
  if (process.env.ENFUSION_EXTRACTED_PATH) {
    config.extractedPath = process.env.ENFUSION_EXTRACTED_PATH;
  }
  if (process.env.ENFUSION_MCP_DATA_DIR) {
    config.dataDir = process.env.ENFUSION_MCP_DATA_DIR;
    // patternsDir is always <dataDir>/patterns unless explicitly set in a config file
    config.patternsDir = join(process.env.ENFUSION_MCP_DATA_DIR, "patterns");
  }
  if (process.env.ENFUSION_WORKBENCH_HOST) {
    config.workbenchHost = process.env.ENFUSION_WORKBENCH_HOST;
  }
  if (process.env.ENFUSION_WORKBENCH_PORT) {
    const port = parseInt(process.env.ENFUSION_WORKBENCH_PORT, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      config.workbenchPort = port;
    }
  }
  if (process.env.ENFUSION_SERVER_PATH) config.serverPath = process.env.ENFUSION_SERVER_PATH;
  if (process.env.ENFUSION_STEAMCMD_PATH) config.steamcmdPath = process.env.ENFUSION_STEAMCMD_PATH;
  if (process.env.ENFUSION_SERVER_PROFILE) config.serverProfilePath = process.env.ENFUSION_SERVER_PROFILE;
  if (process.env.ENFUSION_CLIENT_PROFILES) config.clientProfilesRoot = process.env.ENFUSION_CLIENT_PROFILES;
  if (process.env.ENFUSION_PACKED_PATH) config.packedPath = process.env.ENFUSION_PACKED_PATH;
  if (process.env.ENFUSION_ADDONS_DIR) config.addonsDir = process.env.ENFUSION_ADDONS_DIR;
  if (process.env.ENFUSION_WORKSHOP_PATH) config.workshopPath = process.env.ENFUSION_WORKSHOP_PATH;
  if (process.env.ENFUSION_PROTECTED_ADDONS) {
    config.protectedAddons = process.env.ENFUSION_PROTECTED_ADDONS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.ENFUSION_GITHUB_OWNERS) {
    config.githubOwners = process.env.ENFUSION_GITHUB_OWNERS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.ENFUSION_LOG_ROOTS) {
    config.logRoots = process.env.ENFUSION_LOG_ROOTS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.ENFUSION_DEFAULT_MOD) {
    config.defaultMod = process.env.ENFUSION_DEFAULT_MOD;
  }
  // The config file can hold any JSON value, so the file and the environment variable are read by one rule.
  const coalition: unknown = process.env.ENFUSION_COALITION_TOOLS || config.coalitionTools;
  if (coalition !== undefined) config.coalitionTools = coalition === true || (typeof coalition === "string" && /^(on|1|true)$/i.test(coalition.trim()));

  // The file and the environment variable are read by one rule; an unknown value is rules, with one warning per process.
  const auth = parseAuthMode(process.env.ENFUSION_SCRIPT_AUTH || config.scriptAuth);
  config.scriptAuth = auth.mode;
  if (auth.invalid !== undefined && !authWarned) {
    authWarned = true;
    logger.warn(`ENFUSION_SCRIPT_AUTH "${auth.invalid}" is not rules, all or off; using rules.`);
  }
  if (process.env.ENFUSION_CRASH_LOGS_DIR) config.crashLogsDir = process.env.ENFUSION_CRASH_LOGS_DIR;
  // Same rule for the file and the variable; an unknown value is off, with one warning per process.
  const autoWatch = parseAutoWatch(process.env.ENFUSION_WB_AUTOWATCH || config.autoWatch);
  config.autoWatch = autoWatch.on;
  if (autoWatch.invalid !== undefined && !autoWatchWarned) {
    autoWatchWarned = true;
    logger.warn(`ENFUSION_WB_AUTOWATCH "${autoWatch.invalid}" is not on or off; automatic watch is off.`);
  }

  // Auto-derive gamePath from workbenchPath if not explicitly set.
  //
  // ENFUSION_WORKBENCH_PATH is accepted pointing either at the tools ROOT
  // ("...\Arma Reforger Tools") or at its Workbench SUBDIRECTORY
  // ("...\Arma Reforger Tools\Workbench"): findWorkbenchExe() deliberately
  // supports both. A single fixed "../Arma Reforger" only works for the first:
  // given the subdirectory form it resolves to
  // "...\Arma Reforger Tools\Arma Reforger", which does not exist, and every
  // base-game tool (asset_search, game_read, game_browse, game_duplicate) then
  // silently searched a missing directory instead of reporting a bad path.
  //
  // So try both shapes and take the one that is actually on disk. If neither is,
  // keep the one-level guess and warn: that keeps the previous behaviour for
  // anyone relying on it while making the misconfiguration visible.
  if (!process.env.ENFUSION_GAME_PATH && config.workbenchPath !== DEFAULT_WORKBENCH_PATH) {
    const candidates = [
      resolve(config.workbenchPath, "..", "Arma Reforger"),
      resolve(config.workbenchPath, "..", "..", "Arma Reforger"),
    ];
    const resolved = candidates.find((p) => existsSync(p));
    if (resolved) {
      config.gamePath = resolved;
    } else {
      config.gamePath = candidates[0];
      logger.warn(
        `Could not locate the Arma Reforger game directory from ENFUSION_WORKBENCH_PATH ` +
          `("${config.workbenchPath}"). Tried: ${candidates.join(" and ")}. ` +
          `Base game tools (asset_search, game_read, game_browse) will not find anything: ` +
          `set ENFUSION_GAME_PATH explicitly.`
      );
    }
  }

  // Auto-derive extractedPath from the conventional location beside the addons
  // folder. Without it every inherited value resolves to "unresolved", and
  // relying on the caller to export ENFUSION_EXTRACTED_PATH means one plain
  // `npm run tuning-server` silently degrades the whole tool.
  if (!config.extractedPath) {
    const conventional = resolve(config.projectPath, "..", "extracted");
    if (existsSync(conventional)) {
      config.extractedPath = conventional;
    }
  }

  logger.debug("Config loaded", config);
  return config;
}
