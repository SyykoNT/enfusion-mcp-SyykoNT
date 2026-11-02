import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve, join, sep, basename, dirname, isAbsolute, relative } from "node:path";
import type { Config } from "../config.js";
import { readGproj } from "../workbench/cli.js";
import { forbiddenRoot, realPathOf } from "./safe-path.js";

let shellDocs: string | null | undefined;
/** The Documents folder Windows records (it can be moved anywhere), or null off Windows or when the read fails. */
function shellDocuments(): string | null {
  if (shellDocs !== undefined) return shellDocs;
  shellDocs = null;
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "Personal"], {
      encoding: "utf-8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    });
    const raw = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out)?.[1]?.trim();
    if (raw) shellDocs = raw.replace(/%([^%]+)%/g, (m, v: string) => process.env[v] ?? m);
  } catch {
    // keep the two fixed candidates
  }
  return shellDocs;
}

/**
 * The "My Games" folder Arma Reforger and Workbench write to: under the Documents folder Windows
 * records, else Documents or OneDrive\Documents in the home folder, whichever holds an Arma folder.
 */
export function myGamesDir(documents: string | null = shellDocuments()): string {
  const home = homedir();
  let profile = "";
  try {
    profile = userInfo().homedir;
  } catch {
    // no profile: use the shell folder as written
  }
  // A shell folder inside the user profile follows the home folder, as %USERPROFILE% would
  const rel = documents && profile ? relative(profile, documents) : "";
  const docs = documents && rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(home, rel) : documents;
  const dirs = [...(docs ? [join(docs, "My Games")] : []), join(home, "Documents", "My Games"), join(home, "OneDrive", "Documents", "My Games")];
  return dirs.find((d) => existsSync(join(d, "ArmaReforgerWorkbench")) || existsSync(join(d, "ArmaReforger"))) ?? join(home, "Documents", "My Games");
}

/**
 * Resolve the game data directory (loose/extracted files).
 * Tries gamePath/addons/data first (standard Steam install), then gamePath/addons.
 */
export function resolveGameDataPath(gamePath: string): string | null {
  const dataPath = join(gamePath, "addons", "data");
  if (existsSync(dataPath)) return dataPath;
  const addonsPath = join(gamePath, "addons");
  if (existsSync(addonsPath)) return addonsPath;
  return null;
}

/**
 * Find a loose file in the game data directory.
 * Handles paths with DataXXX prefix ("Data006/Prefabs/...") and bare paths ("Prefabs/...").
 */
export function findLooseFile(gameDataPath: string, relativePath: string): string | null {
  const direct = join(gameDataPath, relativePath);
  if (existsSync(direct)) return direct;

  if (!relativePath.startsWith("Data")) {
    try {
      const entries = readdirSync(gameDataPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("Data")) continue;
        const candidate = join(gameDataPath, entry.name, relativePath);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/** Find the addon directory: by modName (folder name) or first addon with a .gproj. */
export function resolveAddonDir(projectPath: string, modName?: string): string | null {
  if (modName) {
    const base = resolve(projectPath);
    const dir = resolve(base, modName);
    // Prevent path traversal — modName must not escape projectPath
    if (dir !== base && !dir.startsWith(base + sep)) return null;
    return existsSync(dir) ? dir : null;
  }
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectPath, entry.name);
      if (findGproj(dir)) return dir;
    }
  } catch {
    // ignore
  }
  return null;
}

/** True when the addon's .gproj GUID or ID, or its folder name, is listed in ENFUSION_PROTECTED_ADDONS. */
export function isProtectedAddon(config: Config, gproj: string): boolean {
  const { id, guid } = readGproj(gproj);
  const name = basename(dirname(gproj));
  return (config.protectedAddons ?? []).some((p) => [guid, id, name].some((v) => v && v.toLowerCase() === p.toLowerCase()));
}

/** The protected addon folder that holds path (its nearest parent with a .gproj), or null. */
export function protectedAddonOf(config: Config, path: string): string | null {
  for (let d = dirname(resolve(path)); ; d = dirname(d)) {
    const g = findGproj(d);
    if (g) return isProtectedAddon(config, g) ? d : null;
    if (dirname(d) === d) return null;
  }
}

/**
 * The addon a file-writing tool may write into. Needs an explicit projectPath (wins) or modName
 * (under the project path or an ENFUSION_ADDONS_DIR entry): writes never fall back to
 * ENFUSION_DEFAULT_MOD or the first addon found. Refuses forbidden roots (installs, Workshop
 * caches), the projects folder itself, folders without a .gproj and ENFUSION_PROTECTED_ADDONS.
 */
export function resolveWriteAddon(
  config: Config,
  { projectPath, modName }: { projectPath?: string; modName?: string }
): { dir: string; gproj: string } | { error: string } {
  let dir: string;
  if (projectPath) {
    dir = resolve(projectPath);
  } else if (modName) {
    const bases = [config.projectPath, ...(config.addonsDir ?? "").split(",")].map((d) => d.trim()).filter(Boolean);
    const found = bases.map((b) => resolveAddonDir(b, modName)).find((d) => d);
    if (!found) {
      return {
        error: `modName "${modName}" not found under ${config.projectPath} or ENFUSION_ADDONS_DIR. For an addon elsewhere (for example a test addon folder) pass projectPath.`,
      };
    }
    dir = found;
  } else {
    return {
      error: `No target addon. Pass modName (a folder under ${config.projectPath}) or projectPath (an addon root). Writes never default to ENFUSION_DEFAULT_MOD.`,
    };
  }

  const root = forbiddenRoot(config, dir);
  if (root) {
    return { error: `Refused: ${dir} is inside ${root} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS). Copy what you need into your own addon.` };
  }
  if (realPathOf(dir) === realPathOf(config.projectPath)) {
    return { error: `Refused: ${dir} is the projects folder, not an addon. Pass modName or projectPath of one addon.` };
  }
  const gproj = findGproj(dir);
  if (!gproj) return { error: `Not an addon: ${dir} has no .gproj.` };

  if (isProtectedAddon(config, gproj)) {
    return { error: `Refused: ${basename(dir)} (GUID ${readGproj(gproj).guid || "unknown"}) is protected (ENFUSION_PROTECTED_ADDONS). Use a test addon.` };
  }
  return { dir, gproj };
}

const WORKBENCH_EXE_NAME = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";

/**
 * Find the Workbench executable given the tools installation path.
 * Checks the Workbench subdirectory first (standard Steam layout),
 * then the root in case the config points directly to Workbench/.
 */
export function findWorkbenchExe(workbenchPath: string): string | null {
  const subPath = join(workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE_NAME);
  if (existsSync(subPath)) return subPath;

  const rootPath = join(workbenchPath, WORKBENCH_EXE_NAME);
  if (existsSync(rootPath)) return rootPath;

  return null;
}

/** Find the first .gproj file in a directory. */
export function findGproj(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && e.name.endsWith(".gproj")) {
        return join(dir, e.name);
      }
    }
  } catch {
    // ignore
  }
  return null;
}
