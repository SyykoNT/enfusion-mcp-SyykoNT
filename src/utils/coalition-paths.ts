import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { makeLayer, type Layer } from "../pak/stack.js";
import { myGamesDir } from "./game-paths.js";
import { isContained, realPathOf, sameRealPath, validateProjectPath } from "./safe-path.js";

export const CRF_MARKER = join("Tools", "Validation", "validate_mission.py");
export const LOBBY_PREFAB = "Prefabs/!Systems/!Lobby/COA_Lobby.et";
// Workshop GUIDs (their .gproj GUIDs); Workshop folders end in _<GUID>
export const CRF_GUID = "5EB3564A02CE294F";
export const LOBBY_GUID = "69EA43E490A50DBE";

/** A CRF or COALITION-Lobby copy, read the same way whether it is a clone (kind "loose") or a Workshop download. */
export interface CoalitionCopy extends Layer {
  /** "clone <branch> <hash> (<folder>)" or "Workshop <version> (<folder>)" */
  label: string;
}

export interface CoalitionRoots {
  crf: CoalitionCopy;
  lobby: CoalitionCopy;
}

// Parameter help shared by the Coalition tools
export const CRF_PATH_HELP =
  "CRF clone. Default: a clone in the project path (ENFUSION_DEFAULT_MOD first), then Documents\\My Games\\ArmaReforgerWorkbench\\Projects\\Coalition-Reforger-Framework (the Coalition Mission Making Guide's folder), else the Workshop copy. Must be inside the project path or that Projects folder, or be a git worktree of a CRF clone inside them.";
export const LOBBY_PATH_HELP = "COALITION-Lobby clone. Default: a clone next to CRF, else the Workshop copy. Must be inside the project path or the guide's Projects folder, or be the COALITION-Lobby folder next to a git worktree CRF (a junction works).";
export const SOURCE_HELP = "Force where CRF and Lobby are read from: 'clone' (clones only) or 'workshop' (the Workshop downloads, what servers run; not with crfPath or lobbyPath). Default: a clone wins, the Workshop copy fills in.";

/** Where the Coalition Mission Making Guide has mission makers clone CRF. */
export const guideProjectsDir = () => join(myGamesDir(), "ArmaReforgerWorkbench", "Projects");

/** p resolved by validateProjectPath against the first base that holds it, or undefined. */
export function pathInside(bases: string[], p: string): string | undefined {
  for (const base of bases) {
    try {
      return validateProjectPath(base, p);
    } catch {
      // try the next base
    }
  }
  return undefined;
}

/** The main clone of a linked git worktree folder, read from its .git file and commondir without running git; undefined for anything else. */
export function worktreeMainClone(dir: string): string | undefined {
  try {
    const gitFile = join(dir, ".git");
    if (!statSync(gitFile).isFile()) return undefined;
    const m = /^gitdir:\s*(.+?)\s*$/.exec(readFileSync(gitFile, "utf-8").split(/\r?\n/)[0]);
    if (!m) return undefined;
    const gitdir = resolve(dir, m[1]);
    const common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf-8").trim());
    return basename(common) === ".git" ? dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * dir (absolute) when it is a git worktree of a CRF clone inside the allowed folders: the main clone is inside
 * by real path and holds the CRF marker, dir holds it too, and `git worktree list` in the main clone names dir.
 * Segment checks come first, so a bad path never reaches git; git runs only in the main clone.
 */
function acceptedWorktree(p: string, allowed: string[]): string | undefined {
  if (!isAbsolute(p)) return undefined;
  let dir: string;
  try {
    dir = validateProjectPath(p, p); // a path is inside itself, so only the '..', device-name and trailing-dot checks can fail
  } catch {
    return undefined;
  }
  const main = worktreeMainClone(dir);
  if (!main || !existsSync(join(main, CRF_MARKER)) || !existsSync(join(dir, CRF_MARKER))) return undefined;
  try {
    const realMain = realPathOf(main);
    if (!allowed.some((base) => isContained(realPathOf(base), realMain))) return undefined;
    const listed = execFileSync("git", ["-C", main, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
    return listed.some((w) => sameRealPath(w, dir)) ? dir : undefined;
  } catch {
    return undefined; // git missing or failing: the normal refusal
  }
}

export function cloneCopy(dir: string): CoalitionCopy {
  const name = basename(dir);
  let label: string | undefined;
  // git runs only when a reply names the copy
  return Object.defineProperty(makeLayer({ id: name, guid: "", title: name, source: "loose", dir }, 0), "label", {
    get: () => (label ??= `clone ${gitRevision(dir)} (${dir})`),
    enumerable: true,
  }) as CoalitionCopy;
}

function workshopCopy(config: Config, guid: string, what: string): CoalitionCopy {
  const root = config.workshopPath;
  const name = root && existsSync(root) ? readdirSync(root).find((n) => n.toUpperCase().endsWith(`_${guid}`)) : undefined;
  if (!name) {
    throw new Error(`no ${what} Workshop copy (a folder ending in _${guid}) in ${root ?? "the Workshop folder (set ENFUSION_WORKSHOP_PATH)"}`);
  }
  const dir = join(root!, name);
  let version = "";
  try {
    // ServerData.json starts with a UTF-8 BOM
    version = JSON.parse(readFileSync(join(dir, "ServerData.json"), "utf-8").replace(/^﻿/, ""))?.revision?.version ?? "";
  } catch {
    // version stays unknown
  }
  return { ...makeLayer({ id: name, guid, title: what, source: "workshop", dir }, 0), label: `Workshop ${version || "(version unknown)"} (${dir})` };
}

/**
 * Find the CRF and COALITION-Lobby copies the Coalition tools read. A clone always wins:
 * CRF from crfPath, a clone inside config.projectPath (ENFUSION_DEFAULT_MOD first), the guide's
 * Projects folder, else the Workshop copy; Lobby from lobbyPath, a COALITION-Lobby clone beside
 * CRF, else the Workshop copy. `source` forces clones or Workshop copies for both.
 * Throws an Error whose message is meant for the user.
 */
export function resolveCoalitionRoots(config: Config, crfPath?: string, lobbyPath?: string, source?: "clone" | "workshop"): CoalitionRoots {
  if (source === "workshop") {
    if (crfPath || lobbyPath) {
      const named = [crfPath && "crfPath", lobbyPath && "lobbyPath"].filter(Boolean);
      throw new Error(`source "workshop" reads the Workshop copies, but ${named.join(" and ")} ${named.length > 1 ? "name clones" : "names a clone"}. Drop ${named.length > 1 ? "them" : "it"} or source.`);
    }
    try {
      return { crf: workshopCopy(config, CRF_GUID, "CRF"), lobby: workshopCopy(config, LOBBY_GUID, "COALITION-Lobby") };
    } catch (e) {
      throw new Error(`source "workshop": ${(e as Error).message}. Subscribe to it in the game, or drop source.`);
    }
  }
  const allowed = [config.projectPath, guideProjectsDir()];
  let viaWorktree = false;

  let crf: string | undefined;
  if (crfPath) {
    crf = pathInside(allowed, crfPath);
    if (!crf) {
      crf = acceptedWorktree(crfPath, allowed);
      viaWorktree = !!crf;
    }
    if (!crf) throw new Error(`crfPath must be inside ${allowed.join(" or ")}. A git worktree of a CRF clone inside them is also accepted.`);
    if (!existsSync(join(crf, CRF_MARKER))) {
      throw new Error(`No CRF clone with Tools/Validation/validate_mission.py at ${crf}. Pass crfPath.`);
    }
  } else {
    const children = existsSync(config.projectPath)
      ? readdirSync(config.projectPath, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort()
      : [];
    const order = config.defaultMod && children.includes(config.defaultMod) ? [config.defaultMod, ...children] : children;
    const name = order.find((n) => existsSync(join(config.projectPath, n, CRF_MARKER)));
    const guide = join(guideProjectsDir(), "Coalition-Reforger-Framework");
    crf = name ? join(config.projectPath, name) : existsSync(join(guide, CRF_MARKER)) ? guide : undefined;
  }
  let crfCopy: CoalitionCopy;
  if (crf) crfCopy = cloneCopy(crf);
  else {
    const noClone = `No CRF clone with Tools/Validation/validate_mission.py under ${allowed.join(" or ")}`;
    if (source === "clone") throw new Error(`${noClone}. Pass crfPath, or clone CRF as the Coalition Mission Making Guide shows.`);
    try {
      crfCopy = workshopCopy(config, CRF_GUID, "CRF");
    } catch (e) {
      throw new Error(`${noClone}, and ${(e as Error).message}. Clone CRF as the Coalition Mission Making Guide shows, or pass crfPath.`);
    }
  }

  let lobby = crf && join(dirname(crf), "COALITION-Lobby");
  if (lobbyPath) {
    // Beside a worktree CRF the Lobby is a junction, so it is matched by real path after the segment checks
    const beside = viaWorktree && isAbsolute(lobbyPath) && pathInside([lobbyPath], lobbyPath) && sameRealPath(lobbyPath, lobby!);
    const given = pathInside(allowed, lobbyPath) ?? (beside ? resolve(lobbyPath) : undefined);
    if (!given) throw new Error(`lobbyPath must be inside ${allowed.join(" or ")}. The COALITION-Lobby folder next to a git worktree CRF is also accepted.`);
    lobby = given;
  }
  if (lobby && existsSync(lobby)) return { crf: crfCopy, lobby: cloneCopy(lobby) };
  const notFound = `COALITION-Lobby not found ${lobbyPath ? `at ${lobby}` : crf ? `next to ${crf}` : "as a clone"}`;
  if (lobbyPath || source === "clone") {
    throw new Error(`${notFound}. Clone it beside CRF (CI checks out CoalitionArma/COALITION-Lobby@release) or pass lobbyPath.`);
  }
  try {
    return { crf: crfCopy, lobby: workshopCopy(config, LOBBY_GUID, "COALITION-Lobby") };
  } catch (e) {
    throw new Error(`${notFound}, and ${(e as Error).message}. Clone it beside CRF or subscribe to it in the game.`);
  }
}

/** "<branch> <short hash>" of a git clone (read-only), or "unknown". */
export function gitRevision(dir: string): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return [git("branch", "--show-current"), git("rev-parse", "--short", "HEAD")].filter(Boolean).join(" ");
  } catch {
    return "unknown";
  }
}
