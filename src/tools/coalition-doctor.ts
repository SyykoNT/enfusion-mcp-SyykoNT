import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { closure } from "../pak/stack.js";
import { gitOrNull } from "../release/git.js";
import { CRF_GUID, LOBBY_GUID, resolveCoalitionRoots, type CoalitionRoots } from "../utils/coalition-paths.js";
import { findGproj, findWorkbenchExe, myGamesDir } from "../utils/game-paths.js";
import { findPython } from "../utils/python.js";
import { realPathOf } from "../utils/safe-path.js";

/**
 * One row per Tools Setup step of the Coalition Mission Making Guide (Section 2), plus the MCP's own
 * setup, each with what this PC has and the guide's fix. Read only: no writes, no git fetch.
 */

export type State = "ok" | "missing" | "warn" | "info" | "manual";
export interface Row { step: string; item: string; state: State; found: string; fix?: string }

/** What the doctor asks the machine, so tests can fake a whole PC. */
export interface Probe {
  /** Documents\My Games */
  myGames: string;
  /** git, or null when it fails; throws when git is not installed */
  git(dir: string, args: string[]): string | null;
  gitHubDesktop: string | null;
  python: string | null;
  enfusionProtocol: boolean;
}

const regKey = (key: string) => {
  try {
    execFileSync("reg", ["query", key], { windowsHide: true, timeout: 5_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export function defaultProbe(): Probe {
  const desktop = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "GitHubDesktop", "GitHubDesktop.exe");
  return {
    myGames: myGamesDir(),
    git: gitOrNull,
    gitHubDesktop: existsSync(desktop) ? desktop : null,
    python: findPython()?.version ?? null,
    // (unverified) that Workbench registers the protocol as the usual Software\Classes\enfusion URL handler key
    enfusionProtocol: process.platform === "win32" && (regKey("HKCU\\Software\\Classes\\enfusion") || regKey("HKLM\\Software\\Classes\\enfusion")),
  };
}

const ORIGIN = /github\.com[/:]CoalitionArma\/Coalition-Reforger-Framework(\.git)?\/?$/i;
const samePath = (a: string, b: string) => {
  try {
    return realPathOf(a) === realPathOf(b);
  } catch {
    return false;
  }
};

export function doctorRows(config: Config, probe: Probe): Row[] {
  const rows: Row[] = [];
  const add = (step: string, item: string, state: State, found: string, fix?: string) => rows.push({ step, item, state, found, fix });
  const git = (dir: string, args: string[]) => {
    try {
      return probe.git(dir, args);
    } catch {
      return null;
    }
  };

  // Install the Tools [p3]
  const tools = "Install the Tools";
  const wb = findWorkbenchExe(config.workbenchPath);
  const game = existsSync(join(config.gamePath, "ArmaReforgerSteam.exe"));
  add(tools, "Arma Reforger Tools", wb && game ? "ok" : wb ? "warn" : "missing", wb ? `${wb}${game ? "" : `; Arma Reforger not found at ${config.gamePath}`}` : `not found under ${config.workbenchPath}`,
    "In Steam, search your library for Arma Reforger Tools (it needs Arma Reforger in your library). Set ENFUSION_WORKBENCH_PATH / ENFUSION_GAME_PATH if installed elsewhere.");
  const server = ["ArmaReforgerServer.exe", "ArmaReforgerServerDiag.exe"].map((e) => join(config.serverPath, e)).find(existsSync);
  add(tools, "Arma Reforger Server", server ? "ok" : "missing", server ?? `not found under ${config.serverPath}`, "Install Arma Reforger Server from Tools in your Steam library (or set ENFUSION_SERVER_PATH).");
  let gitVersion: string | null = null;
  try {
    gitVersion = probe.git(homedir(), ["--version"]);
  } catch {
    // not installed
  }
  add(tools, "Git", gitVersion ? "ok" : "missing", gitVersion ?? "git not on PATH", "Install Git from https://git-scm.com/downloads.");
  const name = git(homedir(), ["config", "--global", "--get", "user.name"]);
  const email = git(homedir(), ["config", "--global", "--get", "user.email"]);
  add(tools, "Git username and commit email", name && email ? "ok" : "missing", `${name ?? "(no user.name)"} <${email ?? "no user.email"}>`,
    "Set your Git name and the email on your GitHub account (GitHub Desktop: File > Options > Git).");
  add(tools, "GitHub Desktop, signed in", probe.gitHubDesktop ? "ok" : "missing", probe.gitHubDesktop ? `${probe.gitHubDesktop} (sign-in not checked)` : "not found", "Install GitHub Desktop from https://desktop.github.com/ and sign in.");

  // Give the Workbench Your Mods [p4, p5]
  const mods = "Give the Workbench Your Mods";
  const gameAddons = join(probe.myGames, "ArmaReforger", "addons");
  const wbAddons = join(probe.myGames, "ArmaReforgerWorkbench", "addons");
  const oneDrive = /[\\/]OneDrive[\\/ -]/i.test(probe.myGames);
  let roots: CoalitionRoots | undefined, rootsError = "";
  try {
    roots = resolveCoalitionRoots(config);
  } catch (e) {
    rootsError = (e as Error).message;
  }
  const workshop = config.workshopPath && existsSync(config.workshopPath) ? config.workshopPath : undefined;
  if (!workshop) add(mods, "Download the server mods in the game", "missing", `no Workshop folder at ${config.workshopPath}`, "Open Arma Reforger (the game) and download the server's mods.");
  else {
    const missing = new Map<string, string>();
    for (const r of roots ? [roots.crf, roots.lobby] : []) {
      const gproj = findGproj(r.root);
      if (!gproj) continue;
      const c = closure(config, gproj);
      const names = Object.assign({}, ...c.order.map((a) => a.depNames)) as Record<string, string>;
      for (const g of c.missing) missing.set(g, names[g] ?? "");
    }
    const list = [...missing].slice(0, 10).map(([g, n]) => `${n || "?"} {${g}}`).join(", ");
    add(mods, "Download the server mods in the game", missing.size ? "warn" : roots ? "ok" : "info",
      `${readdirSync(workshop).length} folders in ${workshop}; ${roots ? (missing.size ? `${missing.size} CRF/Lobby dependencies not downloaded: ${list}${missing.size > 10 ? ", ..." : ""}` : "every CRF and Lobby dependency is downloaded") : "dependencies not checked (no CRF copy)"}`,
      "Open Arma Reforger (the game) and download the server's mods; the Workbench can't open a mod's prefabs or terrain until it is in the addons folder.");
  }
  const mklink = `mklink /J "${wbAddons}" "${gameAddons}"`;
  let link: State = "missing", linkFound = `no ${wbAddons}`;
  if (existsSync(wbAddons)) {
    if (lstatSync(wbAddons).isSymbolicLink()) [link, linkFound] = ["ok", `${wbAddons} is a link${oneDrive ? " (Documents is on OneDrive, where the guide says links fail; this one resolves)" : ""}`];
    // The guide: a link under OneDrive doesn't work, so a copied folder is the expected setup there
    else [link, linkFound] = [oneDrive ? "info" : "warn", `${wbAddons} is a real folder, not a link${oneDrive ? " (Documents is on OneDrive)" : ""}`];
  }
  add(mods, "Link the game's mods into the Workbench", link, linkFound, oneDrive
    ? "Documents is on OneDrive, where the link doesn't work: copy your addons over by hand whenever the mods update."
    : `With no addons folder in ArmaReforgerWorkbench yet, run in Command Prompt: ${mklink}`);
  const target = existsSync(wbAddons) ? realPathOf(wbAddons) : "";
  add(mods, "Check the link", !target ? "missing" : link !== "ok" ? (oneDrive ? "info" : "warn") : samePath(wbAddons, gameAddons) ? "ok" : "warn",
    !target ? "no link" : link !== "ok" ? "not a link" : `points at ${target}${samePath(wbAddons, gameAddons) ? ", the game's addons" : `, not the game's addons (${realPathOf(gameAddons)})`}`,
    "The Workbench's addons must be a link to the game's addons, so both use the same mods.");
  const projects = join(probe.myGames, "ArmaReforgerWorkbench", "Projects");
  const crfClone = roots?.crf.kind === "loose" ? roots.crf.root : undefined;
  const elsewhere = crfClone && !samePath(dirname(crfClone), projects);
  add(mods, "Create a Projects folder", existsSync(projects) ? "ok" : elsewhere ? "info" : "missing",
    existsSync(projects) ? projects : elsewhere ? `no ${projects}; your clones are in ${dirname(crfClone!)} instead (fine for the MCP through ENFUSION_PROJECT_PATH)` : `no ${projects}`,
    "In Documents\\My Games\\ArmaReforgerWorkbench, create a folder called Projects.");

  // Get the Framework [p6]
  const fw = "Get the Framework";
  if (!crfClone) {
    add(fw, "Clone the framework", "missing", roots ? `no clone; reading the Workshop copy ${roots.crf.root}` : rootsError,
      "In GitHub Desktop: File > Clone Repository > URL https://github.com/CoalitionArma/Coalition-Reforger-Framework into your ArmaReforgerWorkbench\\Projects folder.");
  } else {
    const origin = git(crfClone, ["remote", "get-url", "origin"]);
    add(fw, "Clone the framework", origin && ORIGIN.test(origin) ? "ok" : "warn", `${crfClone}, origin ${origin ?? "(none)"}${elsewhere ? " (not the guide's Projects folder)" : ""}`,
      "Clone https://github.com/CoalitionArma/Coalition-Reforger-Framework (origin should be that address).");
    const branch = git(crfClone, ["branch", "--show-current"]) || "(detached)";
    const release = git(crfClone, ["rev-parse", "--verify", "-q", "refs/heads/release"]) ?? git(crfClone, ["rev-parse", "--verify", "-q", "refs/remotes/origin/release"]);
    add(fw, "Switch to the release branch", release ? "ok" : "missing", `${release ? "release exists" : "no release branch"}; current branch ${branch}`, "Make sure the current branch is release before you start a mission branch.");
    add(fw, "Create your mission branch", branch.startsWith("mission/") ? "ok" : branch === "release" ? "info" : "warn",
      branch.startsWith("mission/") ? branch : `on ${branch}`, "Current branch > New Branch, named mission/ followed by your mission name (mission_names build gives it).");
    const behind = git(crfClone, ["rev-list", "--count", "HEAD..refs/remotes/origin/release"]);
    add(fw, "Know how to update from release", behind === null ? "info" : +behind ? "info" : "ok",
      behind === null ? "no origin/release ref to compare (no fetch run)" : `${behind} commits on origin/release (as last fetched; no fetch run) not in ${branch}`,
      "Branch > Update from release, or run: git pull origin release. Always before you submit.");
  }

  // Open the Workbench [p7]
  const open = "Open the Workbench";
  add(open, "Open the framework project", "manual", "not checked: the Workbench Launcher's project list is not read", "In the Workbench Launcher, double-click COALITION Framework, or Add Project > Add Existing Project > Projects\\Coalition-Reforger-Framework\\addon.gproj.");
  add(open, "Register the enfusion:// protocol", probe.enfusionProtocol ? "ok" : "info", probe.enfusionProtocol ? "enfusion URL handler registered" : "no Software\\Classes\\enfusion key found",
    "Workbench > Options > Workbench tab, then register the enfusion:// protocol.");

  // The MCP's own setup (not in the guide)
  const mcp = "MCP setup";
  add(mcp, "Python 3.11+ (mission_validate)", probe.python ? "ok" : "missing", probe.python ?? "none found (ENFUSION_PYTHON, py -3, python, python3)", "Install Python 3.11 or newer, or set ENFUSION_PYTHON.");
  add(mcp, "COALITION-Lobby", !roots ? "missing" : roots.lobby.kind === "loose" ? "ok" : "info", roots ? roots.lobby.root + (roots.lobby.kind === "loose" ? " (clone)" : " (Workshop copy)") : rootsError,
    "Clone CoalitionArma/COALITION-Lobby beside CRF for Lobby work; the Workshop copy is enough for reading.");
  add(mcp, "ENFUSION_PROJECT_PATH", crfClone && samePath(dirname(crfClone), config.projectPath) ? "ok" : crfClone ? "info" : "warn",
    `${config.projectPath}${crfClone ? (samePath(dirname(crfClone), config.projectPath) ? " holds the CRF clone" : `; the CRF clone is in ${dirname(crfClone)}`) : "; no CRF clone found"}`,
    "Set ENFUSION_PROJECT_PATH to the folder that holds the CRF clone, so project tools and write guards see it.");
  const prot = (config.protectedAddons ?? []).map((g) => g.toUpperCase());
  const missingProt = [CRF_GUID, LOBBY_GUID].filter((g) => !prot.includes(g));
  add(mcp, "ENFUSION_PROTECTED_ADDONS", missingProt.length ? "warn" : "ok", prot.length ? prot.join(",") : "(unset)",
    `Set ENFUSION_PROTECTED_ADDONS to ${CRF_GUID},${LOBBY_GUID} so no tool writes into CRF or Lobby.`);
  const clones = roots ? [roots.crf, roots.lobby].filter((r) => r.kind === "loose").map((r) => r.root) : [];
  const unignored = clones.filter((d) => git(d, ["check-ignore", "-q", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c"]) === null);
  add(mcp, "Workbench handler files git-ignored", !clones.length ? "info" : unignored.length ? "warn" : "ok",
    !clones.length ? "no clones" : unignored.length ? `not ignored in ${unignored.join(", ")}` : `ignored in ${clones.join(", ")}`,
    "Add Scripts/WorkbenchGame/EnfusionMCP/ to the clone's .git/info/exclude, so the MCP's Workbench handlers never reach a commit.");
  return rows;
}

const MARK: Record<State, string> = { ok: "OK", missing: "MISSING", warn: "CHECK", info: "note", manual: "by hand" };

export function doctorText(rows: Row[]): string {
  const count = (s: State) => rows.filter((r) => r.state === s).length;
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  return [
    "## Coalition Tools Setup check",
    "",
    `${count("ok")} OK, ${count("missing")} missing, ${count("warn")} to check, ${count("info")} notes, ${count("manual")} by hand. Read only: nothing was written and no git fetch ran.`,
    "",
    "| Step | Item | State | Found | Fix |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.step} | ${r.item} | ${MARK[r.state]} | ${cell(r.found)} | ${r.state === "ok" ? "" : cell(r.fix ?? "")} |`),
  ].join("\n");
}

export function registerCoalitionDoctor(server: McpServer, config: Config): void {
  server.registerTool(
    "coalition_doctor",
    {
      description:
        "Checks this PC against the Coalition Mission Making Guide's Tools Setup, one row per step with its state and the " +
        "guide's fix: Tools, Server, Git and its name and email, GitHub Desktop, downloaded CRF and Lobby dependencies, the " +
        "Workbench addons link (and OneDrive), the Projects folder, the CRF clone, its origin and branches, the enfusion:// " +
        "protocol; plus the MCP's own setup (Python 3.11+, Lobby, ENFUSION_PROJECT_PATH, ENFUSION_PROTECTED_ADDONS, handler " +
        "git-ignore). Read-only: writes nothing and never runs git fetch.",
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: doctorText(doctorRows(config, defaultProbe())) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `coalition_doctor: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}

