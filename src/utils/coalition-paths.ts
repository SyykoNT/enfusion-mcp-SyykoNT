import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { makeLayer, type Layer } from "../pak/stack.js";
import { myGamesDir } from "./game-paths.js";
import { validateProjectPath } from "./safe-path.js";

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
  "CRF clone. Default: a clone in the project path (ENFUSION_DEFAULT_MOD first), then Documents\\My Games\\ArmaReforgerWorkbench\\Projects\\Coalition-Reforger-Framework (the Coalition Mission Making Guide's folder), else the Workshop copy. Must be inside the project path or that Projects folder.";
export const LOBBY_PATH_HELP = "COALITION-Lobby clone. Default: a clone next to CRF, else the Workshop copy. Must be inside the project path or the guide's Projects folder.";
export const SOURCE_HELP = "Force where CRF and Lobby are read from: 'clone' (clones only) or 'workshop' (the Workshop downloads, what servers run; not with crfPath or lobbyPath). Default: a clone wins, the Workshop copy fills in.";

/** Where the Coalition Mission Making Guide has mission makers clone CRF. */
export const guideProjectsDir = () => join(myGamesDir(), "ArmaReforgerWorkbench", "Projects");

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
  const inside = (p: string, name: string): string => {
    for (const base of allowed) {
      try {
        return validateProjectPath(base, p);
      } catch {
        // try the next allowed folder
      }
    }
    throw new Error(`${name} must be inside ${allowed.join(" or ")}.`);
  };

  let crf: string | undefined;
  if (crfPath) {
    crf = inside(crfPath, "crfPath");
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

  const lobby = lobbyPath ? inside(lobbyPath, "lobbyPath") : crf && join(dirname(crf), "COALITION-Lobby");
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
