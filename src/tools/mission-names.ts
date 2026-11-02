import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { parseAll } from "../formats/enfusion-text.js";
import { prop, slotRoles, SIDES, textOf } from "../coalition/mission-model.js";
import { gitOrNull } from "../release/git.js";
import { CRF_PATH_HELP, LOBBY_PATH_HELP, resolveCoalitionRoots } from "../utils/coalition-paths.js";
import { loadLobbyEnums } from "../utils/lobby-enums.js";
import { loadLobbyMission } from "./mission-inspect.js";

/**
 * The five names the COALITION guide asks for (Name Your Mission), built and checked with the rules
 * Lobby plugin 6 (COA_MissionConfigurationPlugin.c) and CRF's mission_synopsis.py apply. Read only.
 */

export interface NameParts { author: string; mode: string; name: string; terrain: string; slots?: number }
export interface Names { branch: string; world: string; conf: string; inGame: string; prTitle: string }
export interface Note { level: "warning" | "info"; text: string }

/** SCR_StringHelper.Filter(s, ALPHANUMERICAL): keeps ASCII letters and digits only. */
export const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

/** MMDD of Workbench.GetPackedUtcTime(), the date plugin 6 puts in the .conf name. */
export const utcMmdd = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

// shortcut: the guide's web form is not published code; this slug matches both of its examples
// ("The Patrol" -> mission/the-patrol, "BoatPatrol" -> mission/boatpatrol); upgrade if the form's rule turns up
export const branchSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** 'COA TVT32 The Patrol' -> 'The Patrol' (mission_synopsis.py strip_display_prefix). */
export const stripDisplayPrefix = (s: string) => s.match(/^\s*(?:COA|CRF)\s+\S*\d+\s+(.+)$/)?.[1].trim() ?? s.trim();

export function buildNames(p: NameParts, date: Date): Names {
  const count = p.slots ?? "NN";
  return {
    branch: `mission/${branchSlug(p.name)}`,
    world: `Worlds/${p.terrain}/${alnum(p.author)}_${p.mode}_${alnum(p.name)}.ent`,
    conf: `Missions/${p.terrain}/${alnum(p.author)}_${utcMmdd(date)}_${p.mode}${count}_${alnum(p.name)}.conf`,
    inGame: `COA ${p.mode}${count} ${p.name}`,
    // The PR title workflow drops whitespace from the author only (mission_synopsis.py title_author)
    prTitle: `New Mission | ${p.author.replace(/\s+/g, "")} ${p.mode}${count} ${p.name}`,
  };
}

/** Plugin 6 dates the .conf in UTC, so an evening run west of Greenwich gets tomorrow's date. */
export function dateNote(date: Date): Note | undefined {
  const local = `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const utc = utcMmdd(date);
  return local === utc ? undefined : { level: "info", text: `Plugin 6 uses the UTC date: it would write ${utc} now, while the local date is ${local}.` };
}

export interface Header { conf: string; name: string; author: string; mode: string; terrain: string }

/** Rule checks of one world against its .conf files, its slot count, the CRF branch and the known game modes. */
export function checkNames(world: { worldRel: string; slots: number; confs: Header[] }, branch: string | null, modes: string[], now: Date): { notes: Note[]; expected?: Names } {
  const notes: Note[] = [];
  const parts = world.worldRel.split("/");
  const terrain = parts.length >= 3 && parts[0] === "Worlds" ? parts[parts.length - 2] : "";
  if (!terrain) notes.push({ level: "warning", text: `${world.worldRel} is not in a terrain folder under Worlds/: plugin 6 takes the terrain name from the world's parent folder.` });
  const file = parts[parts.length - 1].replace(/\.ent$/i, "");
  const convention = "Plugin 6 does not need it; it is the guide's convention.";

  if (branch === null) notes.push({ level: "info", text: "CRF branch unknown (not a git clone, or detached HEAD)." });
  else if (!branch.startsWith("mission/")) notes.push({ level: "warning", text: `CRF is on branch ${branch}: CI runs the Mission QA job only on branches starting with mission/ (validate.yml).` });

  if (!world.confs.length) {
    if (!/^[^_]+_[^_]+_.+$/.test(file) || !modes.includes(file.split("_")[1])) {
      notes.push({ level: "info", text: `World file ${file}.ent does not follow the guide's Author_MODE_Name.ent (MODE one of the game modes). ${convention}` });
    }
    notes.push({ level: "warning", text: `No mission .conf under Missions/${terrain}/ points at this world: run plugin 6 (Generate Config File) once.` });
    return { notes };
  }
  if (world.confs.length > 1) notes.push({ level: "warning", text: `${world.confs.length} .conf files point at this world (${world.confs.map((c) => c.conf).join(", ")}): plugin 6 says never run it twice for one mission.` });

  let expected: Names | undefined;
  for (const h of world.confs) {
    const name = stripDisplayPrefix(h.name);
    const fileName = h.conf.split("/").pop()!;
    const m = fileName.match(/^([A-Za-z0-9]*)_(\d\d)(\d\d)_([A-Z]+?)(\d+)_([A-Za-z0-9]*)\.conf$/);
    const at = `${h.conf}:`;
    if (!m) {
      notes.push({ level: "warning", text: `${at} name does not match plugin 6's Author_MMDD_MODEnn_Name.conf.` });
    } else {
      const [, a, mm, dd, mode, n, nm] = m;
      if (a !== alnum(h.author)) notes.push({ level: "warning", text: `${at} author part ${a} differs from m_sAuthor "${h.author}" (expected ${alnum(h.author)}).` });
      if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31) notes.push({ level: "warning", text: `${at} date part ${mm}${dd} is not a valid MMDD.` });
      if (mode !== h.mode) notes.push({ level: "warning", text: `${at} mode part ${mode} differs from m_sGameMode ${h.mode}.` });
      if (+n !== world.slots) notes.push({ level: "info", text: `${at} names ${n} slots; the world now has ${world.slots}. The PR title counts the world, the file name keeps plugin 6's count.` });
      if (nm !== alnum(name)) notes.push({ level: "warning", text: `${at} name part ${nm} differs from the mission name in m_sName ("${name}", expected ${alnum(name)}).` });
    }
    if (!modes.includes(h.mode)) notes.push({ level: "warning", text: `${at} m_sGameMode ${h.mode || "(empty)"} is not a COA_EGamemode member.` });
    if (h.terrain !== terrain) notes.push({ level: "warning", text: `${at} m_sTerrainName "${h.terrain}" differs from the world's terrain folder ${terrain}.` });
    const header = h.name.match(/^COA ([A-Z]+?)(\d+) (.+)$/);
    if (!header) notes.push({ level: "warning", text: `${at} m_sName "${h.name}" does not match plugin 6's "COA <MODE><count> <name>".` });
    else if (header[1] !== h.mode) notes.push({ level: "warning", text: `${at} m_sName mode ${header[1]} differs from m_sGameMode ${h.mode}.` });
    else if (+header[2] !== world.slots) notes.push({ level: "info", text: `${at} m_sName counts ${header[2]} slots; the world now has ${world.slots}. Players see the m_sName count.` });
    expected ??= buildNames({ author: h.author, mode: h.mode, name, terrain, slots: world.slots }, now);
  }
  if (expected && expected.world !== world.worldRel) {
    notes.push({ level: "info", text: `World file ${world.worldRel} differs from the guide's Author_MODE_Name.ent for this .conf (${expected.world}). ${convention}` });
  }
  if (expected && branch?.startsWith("mission/") && branch !== expected.branch) {
    notes.push({ level: "info", text: `Branch ${branch} differs from the guide's form (${expected.branch}); CI only needs the mission/ prefix.` });
  }
  return { notes, expected };
}

export interface NamesParams {
  action: "build" | "check";
  author?: string;
  mode?: string;
  name?: string;
  terrain?: string;
  slots?: number;
  world?: string;
  crfPath?: string;
  lobbyPath?: string;
}

const rows = (n: Names) => [
  `BRANCH              ${n.branch}`,
  `WORLD FILE          ${n.world}`,
  `MISSION CONFIG      ${n.conf}`,
  `IN-GAME NAME        ${n.inGame}`,
  `PULL REQUEST TITLE  ${n.prTitle}`,
];
const noteLines = (notes: Note[]) => notes.map((n) => `${n.level.toUpperCase()} ${n.text}`);

export function missionNames(config: Config, p: NamesParams, now = new Date()): string {
  const roots = resolveCoalitionRoots(config, p.crfPath, p.lobbyPath);
  const { crf, lobby } = roots;
  const modes = [...(loadLobbyEnums([lobby, crf]).get("COA_EGamemode")?.keys() ?? [])];

  if (p.action === "build") {
    const missing = (["author", "mode", "name", "terrain"] as const).filter((k) => !p[k]?.trim());
    if (missing.length) throw new Error(`build needs ${missing.join(", ")}.`);
    const mode = modes.find((m) => m.toLowerCase() === p.mode!.trim().toLowerCase());
    if (!mode) throw new Error(`Unknown game mode "${p.mode}". COA_EGamemode (Lobby and CRF): ${modes.join(", ")}.`);
    // The terrain becomes a folder name in two paths
    if (!/^[A-Za-z0-9_\-]+$/.test(p.terrain!)) throw new Error(`terrain must be one folder name (letters, digits, _ or -), got "${p.terrain}".`);
    for (const k of ["author", "name"] as const) if (!alnum(p[k]!)) throw new Error(`${k} "${p[k]}" has no letters or digits, which plugin 6's file name keeps.`);
    const names = buildNames({ author: p.author!.trim(), mode, name: p.name!.trim(), terrain: p.terrain!, slots: p.slots }, now);
    const notes = [dateNote(now), p.slots === undefined ? { level: "info" as const, text: "NN is the slot count: plugin 6 counts every BLUFOR, OPFOR, INDFOR and CIV slot in the world. Pass slots, or run check on the world." } : undefined].filter((n): n is Note => !!n);
    return [`mission_names build (rules from Lobby plugin 6 and CRF mission_synopsis.py)`, `CRF: ${crf.label}`, `Lobby: ${lobby.label}`, ...rows(names), ...noteLines(notes)].join("\n");
  }

  if (!p.world) throw new Error("check needs world (the mission .ent).");
  const m = loadLobbyMission(config, roots, p.world);
  const slots = SIDES.reduce((n, s) => n + slotRoles(m.slots[s]).length, 0);
  const confs: Header[] = m.confs.map((conf) => {
    const header = parseAll(textOf(m.copy, conf) ?? "").find((n) => n.type === "SCR_MissionHeader");
    const f = (k: string) => (prop(header, k) ?? "").trim();
    return { conf, name: f("m_sName"), author: f("m_sAuthor"), mode: f("m_sGameMode"), terrain: f("m_sTerrainName") };
  });
  // A Workshop copy has no branch: checkNames then says the branch is unknown
  const branch = (crf.kind === "loose" && gitOrNull(crf.root, ["branch", "--show-current"])) || null;
  const { notes, expected } = checkNames({ worldRel: m.worldRel, slots, confs }, branch, modes, now);
  return [
    `mission_names check ${m.worldRel}  (${slots} slots, branch ${branch ?? "unknown"})`,
    `CRF: ${crf.label}`,
    `Lobby: ${lobby.label}`,
    ...confs.map((c) => `conf ${c.conf}: m_sName "${c.name}", m_sAuthor "${c.author}", m_sGameMode ${c.mode}, m_sTerrainName ${c.terrain}`),
    ...(notes.length ? noteLines(notes) : ["OK: the world, its .conf and the branch follow plugin 6's rules."]),
    ...(expected ? ["Names from the .conf and the world's slot count (MISSION CONFIG dated today):", ...rows(expected)] : []),
  ].join("\n");
}

export function registerMissionNames(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_names",
    {
      description:
        "The COALITION guide's five mission names (branch, world file, mission .conf, in-game name, PR title), with the rules " +
        "Lobby plugin 6 and CRF's PR workflow apply. build: from author, game mode (checked against COA_EGamemode), mission " +
        "name, terrain folder and optional slot count; the .conf date is UTC, as plugin 6 writes it. check: compares a world's " +
        "path, its .conf names and header with those rules and its slot count, and the CRF branch with mission/. Read-only, offline.",
      inputSchema: {
        action: z.enum(["build", "check"]),
        author: z.string().optional().describe("build: author as typed in plugin 6, e.g. 'Tanaka'"),
        mode: z.string().optional().describe("build: game mode, a COA_EGamemode member such as TVT, COOP, COTVT"),
        name: z.string().optional().describe("build: mission name, e.g. 'The Patrol'"),
        terrain: z.string().optional().describe("build: terrain folder under Worlds/, e.g. 'Arland'"),
        slots: z.number().int().min(0).max(999).optional().describe("build: slot count (all sides); NN when omitted"),
        world: z.string().optional().describe("check: mission world .ent, CRF-relative, project-relative or absolute, inside the project path"),
        crfPath: z.string().optional().describe(CRF_PATH_HELP),
        lobbyPath: z.string().optional().describe(LOBBY_PATH_HELP),
      },
    },
    async (params) => {
      try {
        return { content: [{ type: "text" as const, text: missionNames(config, params) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `mission_names: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
