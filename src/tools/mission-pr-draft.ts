import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { components, member, prop, SIDES, textOf, type Side } from "../coalition/mission-model.js";
import { prefabClassifier, type PrefabKind } from "../coalition/mission-prefabs.js";
import { taskEntries } from "../coalition/name-refs.js";
import { installedAddons } from "../pak/stack.js";
import { gitOrNull } from "../release/git.js";
import { resolveCoalitionRoots, type CoalitionCopy } from "../utils/coalition-paths.js";
import { enumDefault, loadLobbyEnums } from "../utils/lobby-enums.js";
import { stripGuid } from "../utils/prefab-ancestry.js";
import { workbenchProfileDir } from "../workbench/cli.js";
import { parseScriptErrors } from "../workbench/script-errors.js";
import { SETTINGS_FIELD } from "./gearscript-inspect.js";
import { loadLobbyMission } from "./mission-inspect.js";
import { changedWorld, missionGit } from "./mission-git.js";

const ROLES = ["Attacking", "Defending", "NA"] as const;
export interface PrDraftOptions {
  world?: string;
  crfPath?: string;
  lobbyPath?: string;
  base?: string;
  roles?: Partial<Record<Side, (typeof ROLES)[number]>>;
}

const ASSETS: [PrefabKind, string][] = [["msp", "MSP"], ["vehicleSpawner", "vehicle spawner"], ["depot", "vehicle depot"]];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const deps = (gproj: string | null) => [...(gproj ?? "").matchAll(/"([0-9A-Fa-f]{16})"/g)].map((m) => m[1].toUpperCase());

/** m_FactionName of the gearscript the Lobby sets for a side, read from CRF or the Lobby. */
function factionOf(copies: CoalitionCopy[], gearscript: string): string | undefined {
  const text = copies.map((c) => textOf(c, stripGuid(gearscript))).find((t) => t !== undefined);
  return text?.match(/^\s*m_FactionName\s+"([^"]+)"/m)?.[1];
}

/** Counts from the newest Workbench session log, or why there are none. */
export async function newestWorkbenchErrors(config: Config): Promise<{ session: string; errors: number; vme: number; groups: number; text: string } | null> {
  const root = join(workbenchProfileDir(config), "logs");
  const session = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("logs_")).sort().reverse()[0] : undefined;
  const file = session && ["error.log", "console.log"].map((f) => join(root, session, f)).find((f) => existsSync(f));
  if (!file) return null;
  const s = await parseScriptErrors(readFileSync(file, "utf-8").split(/\r?\n/));
  const text = `Newest Workbench session ${session}: ${plural(s.errors, "script error")} and ${plural(s.vme, "VM exception")} in ${plural(s.groups.length, "group")} (script_errors has the details).`;
  return { session: session!, errors: s.errors, vme: s.vme, groups: s.groups.length, text };
}

/** Text for the hand-filled sections of CRF's mission PR template. Reads files only; never posts. */
export async function missionPrDraft(config: Config, opts: PrDraftOptions = {}): Promise<{ text: string; unfilled: string[] }> {
  const roots = resolveCoalitionRoots(config, opts.crfPath, opts.lobbyPath);
  const { crf, lobby: lobbyCopy } = roots;
  const unfilled: string[] = [];
  let branch: ReturnType<typeof missionGit> | undefined;
  try {
    branch = missionGit(config, { crfPath: opts.crfPath, lobbyPath: opts.lobbyPath, base: opts.base });
  } catch (e) {
    if (!opts.world) throw e;
    unfilled.push(`Links to Added Mods: ${(e as Error).message}`);
  }
  const world = opts.world ?? changedWorld(branch!);
  const m = loadLobbyMission(config, roots, world);
  const classify = prefabClassifier(config, [...new Set([lobbyCopy, crf, m.copy])]);
  const classes = m.entities.map((e) => ({ e, c: classify(e.prefab, e.className) }));

  // factions and assets
  const sides = SIDES.filter((s) => m.slots[s]);
  const faction: string[] = [];
  for (const side of sides) {
    const gs = prop(member(m.lobby.node, SETTINGS_FIELD[side]), "m_rGearScript");
    const name = gs && (factionOf([crf, lobbyCopy], gs) ?? basename(stripGuid(gs), ".conf"));
    if (!gs) unfilled.push(`${side} faction: no gearscript set in ${SETTINGS_FIELD[side]}`);
    if (!opts.roles?.[side]) unfilled.push(`${side}: Attacking, Defending or NA (your call)`);
    const assets = ASSETS.map(([kind, word]) => {
      const named = classes.filter((x) => x.c?.kind === kind && x.c.side === side).map((x) => x.e.name);
      return named.length ? `${plural(named.length, word)}${named.some(Boolean) ? ` (${named.filter(Boolean).join(", ")})` : ""}` : "";
    }).filter(Boolean);
    faction.push(`${side} - ${name ?? "(fill in faction)"} - ${opts.roles?.[side] ?? "Attacking/Defending/NA"}`, `${side} Assets: ${assets.join(", ") || "(none in the files)"}`, "");
  }
  const vehicles = m.entities.filter((e) => e.prefab && /^Prefabs\/Vehicles\//i.test(stripGuid(e.prefab))).map((e) => e.name ?? basename(stripGuid(e.prefab!), ".et"));
  if (vehicles.length) unfilled.push(`Placed vehicles have no side in the files; add them to the right Assets line: ${vehicles.join(", ")}`);
  for (const s of SIDES.filter((x) => !m.slots[x])) unfilled.push(`${s}: no slots, line left out`);

  // objectives
  const modes = components(m.lobby).map((c) => c.type).filter((t) => /game ?mode/i.test(t));
  const entries = taskEntries(m.entities);
  const enums = entries.length ? loadLobbyEnums([lobbyCopy, crf]) : new Map();
  const unset = (e: string) => `${enumDefault(enums, e) ?? "?"} (default)`;
  const objectives = [
    ...modes.map((t) => `- Game mode: ${t}`),
    ...entries.map((t) => `- ${t.label ?? "New Task"}: ${t.type ?? unset("CRF_EObjectiveTaskType")} for ${t.side ?? unset("CRF_EObjectiveNotifySide")}`),
  ];
  if (!objectives.length) unfilled.push("Objectives: no game mode component or Task Creator entry on COA_Lobby");
  unfilled.push("Objectives: win conditions in your own words");

  // testing and mods
  const testing = (await newestWorkbenchErrors(config))?.text;
  if (!testing) unfilled.push("Technical testing: no Workbench session log found");
  const links: string[] = [];
  if (branch) {
    // missionGit succeeded, so CRF is a clone
    const before = new Set(deps(gitOrNull(crf.root, ["show", `${branch.baseCommit}:addon.gproj`])));
    const now = deps(textOf(crf, "addon.gproj") ?? null);
    const added = now.filter((g) => !before.has(g));
    const removed = [...before].filter((g) => !now.includes(g));
    const names = added.length || removed.length ? installedAddons(config) : new Map();
    const label = (g: string) => names.get(g)?.name ?? g;
    links.push(...added.map((g) => `- ${label(g)}: https://reforger.armaplatform.com/workshop/${g} (purpose: fill in)`));
    links.push(...removed.map((g) => `- Removed: ${label(g)} (${g})`));
    if (added.length) unfilled.push("Links to Added Mods: the purpose of each mod");
  }

  const text = [
    `<!-- Draft from ${m.worldRel} by mission_pr_draft. Paste into the matching sections; you own the text. Title, Automated Checks and Synopsis are filled by CI. -->`,
    "",
    "**Faction(s):**",
    "",
    ...faction,
    "**Objectives/Win Conditions:**",
    "",
    ...(objectives.length ? objectives : ["<mission objectives>"]),
    "",
    "**Any Technical testing needed? Triggers? Scripts?:**",
    "",
    testing ? `${testing} <enter text here>` : "<enter text here>",
    "",
    "**Links to Added Mods**",
    "",
    ...(links.length ? links : [branch ? "None (addon.gproj dependencies unchanged)" : "<enter name link and purpose here>"]),
    "",
    "**Design concept/thoughts:**",
    "",
    "<enter text here>",
    "",
    "**Other Notes:**",
    "",
    "<Assets? Admin notes? Anything else?>",
  ];
  unfilled.push("Mission Briefing Screenshot, Design concept/thoughts, Other Notes: yours to write");
  return { text: text.join("\n"), unfilled };
}

export function registerMissionPrDraft(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_pr_draft",
    {
      description:
        "Draft the hand-filled sections of CRF's mission PR template from the mission files: one 'SIDE - faction - Attacking/Defending/NA' " +
        "line per slotted side (faction from the side's gearscript), assets per side (MSPs, vehicle spawners, depots), objectives from game " +
        "mode components and Task Creator entries, a testing note from the newest Workbench log, and mods added to addon.gproj against " +
        "origin/release. Lists what it could not fill. Returns text only: never posts, never touches GitHub.",
      inputSchema: {
        world: z.string().optional().describe("Mission world (.ent), CRF-relative or absolute (default: the one world the branch changes)"),
        crfPath: z.string().optional().describe("CRF clone inside the project path, or a git worktree of one (default: found under the project path)"),
        lobbyPath: z.string().optional().describe("COALITION-Lobby clone (default: CRF's sibling; a junction to the Lobby clone beside a worktree CRF works)"),
        base: z.string().optional().describe("Ref for the addon.gproj comparison (default origin/release)"),
        roles: z.object(Object.fromEntries(SIDES.map((s) => [s, z.enum(ROLES).optional()]))).optional()
          .describe("Attacking, Defending or NA per side, when the author has decided; otherwise the line keeps 'Attacking/Defending/NA'"),
      },
    },
    async (opts) => {
      try {
        const r = await missionPrDraft(config, opts as PrDraftOptions);
        return { content: [{ type: "text" as const, text: `${r.text}\n\n---\nNot filled from the files:\n${r.unfilled.map((u) => `- ${u}`).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    }
  );
}
