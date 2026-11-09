import type { Config } from "../config.js";
import { resolveWriteAddon } from "../utils/game-paths.js";

/**
 * Why the tuning server may not write into addonPath, or null when it may.
 * The rule every other file-writing tool uses (resolveWriteAddon): game or Tools install, Workshop cache,
 * ENFUSION_FORBIDDEN_DIRS, the projects folder itself, a folder without a .gproj, ENFUSION_PROTECTED_ADDONS.
 */
export function writeRefusal(config: Config, addonPath: string): string | null {
  const r = resolveWriteAddon(config, { projectPath: addonPath });
  return "error" in r ? r.error : null;
}
