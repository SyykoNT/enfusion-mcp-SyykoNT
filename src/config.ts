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
}

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
  if (process.env.ENFUSION_DEFAULT_MOD) {
    config.defaultMod = process.env.ENFUSION_DEFAULT_MOD;
  }

  // Auto-derive gamePath from workbenchPath if not explicitly set.
  //
  // ENFUSION_WORKBENCH_PATH is accepted pointing either at the tools ROOT
  // ("...\Arma Reforger Tools") or at its Workbench SUBDIRECTORY
  // ("...\Arma Reforger Tools\Workbench") — findWorkbenchExe() deliberately
  // supports both. A single fixed "../Arma Reforger" only works for the first:
  // given the subdirectory form it resolves to
  // "...\Arma Reforger Tools\Arma Reforger", which does not exist, and every
  // base-game tool (asset_search, game_read, game_browse, game_duplicate) then
  // silently searched a missing directory instead of reporting a bad path.
  //
  // So try both shapes and take the one that is actually on disk. If neither is,
  // keep the one-level guess and warn — that keeps the previous behaviour for
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
          `Base game tools (asset_search, game_read, game_browse) will not find anything — ` +
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
