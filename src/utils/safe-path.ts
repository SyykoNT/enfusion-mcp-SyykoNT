import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { myGamesDir } from "./game-paths.js";

/**
 * Validate that a user-supplied name is safe for use as a filename.
 * Rejects path traversal, path separators, and OS-reserved characters.
 */
export function validateFilename(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Filename must not be empty");
  }

  if (name.includes("..")) {
    throw new Error("Filename must not contain '..'");
  }

  if (/[/\\]/.test(name)) {
    throw new Error("Filename must not contain path separators (/ or \\)");
  }

  // Windows reserved characters: < > : " | ? *
  if (/[<>:"|?*]/.test(name)) {
    throw new Error("Filename contains invalid characters");
  }

  if (RESERVED_DEVICE_NAME.test(name)) {
    throw new Error(`Filename uses reserved name: ${name}`);
  }

  // Windows silently strips trailing dots and spaces, so "foo.et." becomes "foo.et"
  // on disk. Left alone that defeats the existsSync overwrite guard every generator
  // relies on: passing "foo.et." reports no collision and then clobbers "foo.et".
  if (/[. ]$/.test(name)) {
    throw new Error(
      `Filename must not end with a dot or space: "${name}" — Windows silently strips these, which would overwrite a different file than the one named`
    );
  }
}

/** Windows reserved device names, which open a device rather than creating a file. */
const RESERVED_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;

/**
 * Validate that a name is a valid Enforce Script identifier.
 * Must start with a letter or underscore, followed by letters, digits, or underscores.
 */
export function validateEnforceIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      "Must be a valid Enforce identifier (letters, digits, underscores only, must start with a letter or underscore)"
    );
  }
}

/**
 * Check that resolved is equal to or contained within normalizedBase.
 * Uses trailing separator to prevent prefix collisions (e.g., C:\Proj vs C:\ProjEvil).
 */
export function isContained(normalizedBase: string, resolved: string): boolean {
  return resolved === normalizedBase || resolved.startsWith(normalizedBase + sep);
}

/**
 * Real path of p after junctions and symlinks, resolved through its deepest existing ancestor
 * (p itself may not exist yet). Lower-cased on Windows so comparisons ignore case.
 * Throws when an existing part of the path cannot be read.
 */
export function realPathOf(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      const real = join(realpathSync.native(cur), ...rest);
      return process.platform === "win32" ? real.toLowerCase() : real;
    } catch (e) {
      const parent = dirname(cur);
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === cur) throw e;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Folders no tool writes into: game and Tools installs, both Workshop caches, ENFUSION_FORBIDDEN_DIRS. */
export function forbiddenRoots(config: Config): string[] {
  const roots = [
    config.gamePath,
    config.workbenchPath,
    join(myGamesDir(), "ArmaReforger", "addons"),
    join(myGamesDir(), "ArmaReforgerWorkbench", "addons"),
    config.workshopPath,
    ...(process.env.ENFUSION_WORKBENCH_PROFILE ? [join(process.env.ENFUSION_WORKBENCH_PROFILE, "addons")] : []),
    ...(process.env.ENFUSION_FORBIDDEN_DIRS ?? "").split(","),
  ];
  return roots.map((r) => r?.trim()).filter((r): r is string => !!r);
}

/**
 * The forbidden root that holds path, compared by real path, or null when path is allowed.
 * A path whose real path cannot be read is refused (returned as its own root).
 */
export function forbiddenRoot(config: Config, path: string): string | null {
  let target: string;
  try {
    target = realPathOf(path);
  } catch {
    return path;
  }
  const profile = process.env.ENFUSION_WORKBENCH_PROFILE;
  const wbAddons = [join(myGamesDir(), "ArmaReforgerWorkbench", "addons"), ...(profile ? [join(profile, "addons").trim()] : [])];
  const denied = (process.env.ENFUSION_FORBIDDEN_DIRS ?? "").split(",").filter((d) => d.trim());
  for (const root of forbiddenRoots(config)) {
    let real: string;
    try {
      real = realPathOf(root);
    } catch {
      continue;
    }
    if (!isContained(real, target)) continue;
    // Workbench's addons folder (My Games or the profile's) is also its default project folder: as the project root, only
    // its Workshop downloads stay forbidden. An ENFUSION_FORBIDDEN_DIRS entry for the same folder always wins.
    if (wbAddons.includes(root) && isRealPath(config.projectPath, real) && !denied.some((d) => isRealPath(d, real))) {
      const top = join(real, relative(real, target).split(sep)[0]);
      if (top !== real && existsSync(join(top, "ServerData.json"))) return top;
      continue;
    }
    return root;
  }
  return null;
}

function isRealPath(p: string | undefined, real: string): boolean {
  try {
    return !!p && realPathOf(p.trim()) === real;
  } catch {
    return false;
  }
}

/**
 * Validate that a resolved path stays within the base directory.
 * Combines validateFilename + traversal check.
 */
export function safePath(basePath: string, ...segments: string[]): string {
  for (const seg of segments) {
    validateFilename(seg);
  }

  const normalizedBase = resolve(basePath);
  const resolved = resolve(normalizedBase, ...segments);

  if (!isContained(normalizedBase, resolved)) {
    throw new Error("Path traversal not allowed: resolved path is outside project");
  }

  return resolved;
}

/**
 * Validate a relative sub-path (which may contain slashes) stays within the base directory.
 * Used by project_read / project_write / project_browse for user-supplied relative paths.
 */
export function validateProjectPath(basePath: string, subPath: string): string {
  if (subPath.includes("..")) {
    throw new Error("Path traversal not allowed: '..' segments are blocked");
  }

  // Containment alone is not enough: a path can stay inside the project and still
  // not address a file. On Windows "sub/NUL.txt" opens the null device — the write
  // reports success and the data is silently discarded — and a segment ending in a
  // dot or space is normalised to a different name than the caller asked for.
  for (const segment of subPath.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    if (RESERVED_DEVICE_NAME.test(segment)) {
      throw new Error(`Path segment uses a reserved device name: "${segment}"`);
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(
        `Path segment must not end with a dot or space: "${segment}" — Windows strips these, so the write would land on a different path than requested`
      );
    }
  }

  const normalizedBase = resolve(basePath);
  const resolved = resolve(normalizedBase, subPath);

  if (!isContained(normalizedBase, resolved)) {
    throw new Error("Path traversal not allowed: resolved path is outside project");
  }

  return resolved;
}
