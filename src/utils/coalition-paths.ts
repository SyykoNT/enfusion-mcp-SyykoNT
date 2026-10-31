import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "./safe-path.js";

const CRF_MARKER = join("Tools", "Validation", "validate_mission.py");

export interface CoalitionRoots {
  crf: string;
  lobby: string;
}

/**
 * Find the CRF and COALITION-Lobby clones, both inside config.projectPath.
 * CRF defaults to the ENFUSION_DEFAULT_MOD folder if it holds the CRF validator, else the
 * first child of the project path that does; Lobby defaults to CRF's sibling COALITION-Lobby.
 * Throws an Error whose message is meant for the user.
 */
export function resolveCoalitionRoots(config: Config, crfPath?: string, lobbyPath?: string): CoalitionRoots {
  const inside = (p: string, name: string): string => {
    try {
      return validateProjectPath(config.projectPath, p);
    } catch {
      throw new Error(`${name} must be inside ${config.projectPath}.`);
    }
  };

  let crf: string | undefined;
  if (crfPath) {
    crf = inside(crfPath, "crfPath");
    if (!existsSync(join(crf, CRF_MARKER))) {
      throw new Error(`No CRF clone with Tools/Validation/validate_mission.py at ${crf}. Pass crfPath.`);
    }
  } else {
    const children = existsSync(config.projectPath)
      ? readdirSync(config.projectPath, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [];
    const order = config.defaultMod && children.includes(config.defaultMod) ? [config.defaultMod, ...children] : children;
    const name = order.find((n) => existsSync(join(config.projectPath, n, CRF_MARKER)));
    if (!name) {
      throw new Error(`No CRF clone with Tools/Validation/validate_mission.py under ${config.projectPath}. Pass crfPath.`);
    }
    crf = join(config.projectPath, name);
  }

  const lobby = lobbyPath ? inside(lobbyPath, "lobbyPath") : join(dirname(crf), "COALITION-Lobby");
  if (!existsSync(lobby)) {
    throw new Error(
      `COALITION-Lobby not found next to ${crf}. Clone it beside CRF (CI checks out CoalitionArma/COALITION-Lobby@release) or pass lobbyPath.`
    );
  }
  return { crf, lobby };
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
