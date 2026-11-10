import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { Config } from "../config.js";
import { changedWorld, missionGit, type MissionGit } from "./mission-git.js";
import { registerMissionInspect } from "./mission-inspect.js";
import { missionNames } from "./mission-names.js";
import { newestWorkbenchErrors } from "./mission-pr-draft.js";
import { registerMissionValidate } from "./mission-validate.js";

export type RowStatus = "pass" | "fail" | "warn" | "not run" | "in game" | "you";
export interface Row { section: string; item: string; status: RowStatus; detail?: string }
export interface PreflightOptions { world?: string; crfPath?: string; lobbyPath?: string; base?: string }

type Result = { content: { text: string }[]; isError?: boolean };
/** A registered tool's handler, called with its own input schema applied (defaults and validation), as the MCP server would. */
function toolHandler(register: (s: McpServer, c: Config) => void, config: Config): (args: Record<string, unknown>) => Promise<Result> {
  let schema: ZodRawShape = {};
  let handler: (a: unknown) => Promise<Result> = async () => ({ content: [{ text: "not registered" }], isError: true });
  register({ registerTool: (_n: string, def: { inputSchema: ZodRawShape }, h: typeof handler) => { schema = def.inputSchema; handler = h; } } as unknown as McpServer, config);
  return (args) => handler(z.object(schema).parse(args));
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BEFORE = "Before you submit [p17]", SUBMIT = "Submitting [p19]", PR = "Pull request checklist [p19]";

/** One go/no-go before a push: mission_git, mission_names, mission_validate (qa, synopsis, resources), mission_inspect rules, newest Workbench log. */
export async function missionPreflight(config: Config, opts: PreflightOptions = {}): Promise<{ rows: Row[]; world?: string; verdict: "go" | "no-go" }> {
  const rows: Row[] = [];
  const roots = { crfPath: opts.crfPath, lobbyPath: opts.lobbyPath };
  let g: MissionGit | undefined;
  let gitError: string | undefined;
  try {
    g = missionGit(config, { ...roots, base: opts.base });
  } catch (e) {
    gitError = errorText(e);
  }
  let world = opts.world;
  let worldError: string | undefined;
  if (!world && g) {
    try {
      world = changedWorld(g);
    } catch (e) {
      worldError = errorText(e);
    }
  }
  const noWorld = worldError ?? gitError ?? "no world";
  let sideWarnings: string[] = [];

  // Submitting [p19]
  if (g) {
    rows.push({ section: SUBMIT, item: "Branch is mission/<name> (CI runs Mission QA only there)", status: g.branch.startsWith("mission/") ? "pass" : "fail", detail: g.branch });
    rows.push({ section: SUBMIT, item: "Up to date with release", status: g.behind ? "fail" : "pass", detail: `${g.behind} behind ${g.base}, as of the last fetch${g.fetchedAt ? ` (${g.fetchedAt})` : " (never fetched)"}` });
    const open = g.files.filter((f) => f.where.some((w) => w !== "committed"));
    rows.push({ section: SUBMIT, item: "World, layers, .conf and added files committed", status: open.length ? "fail" : "pass", detail: open.length ? `${open.length} uncommitted or untracked: ${open.slice(0, 5).map((f) => f.path).join(", ")}${open.length > 5 ? ", ..." : ""}` : undefined });
    const handlers = g.warnings.filter((w) => w.startsWith("MCP handler files"));
    rows.push({ section: SUBMIT, item: "No MCP handler files in the change", status: handlers.length ? "fail" : "pass", detail: handlers[0] });
    const other = g.warnings.filter((w) => !w.startsWith("MCP handler files") && !w.startsWith("Branch ") && !/commits behind/.test(w));
    rows.push({ section: SUBMIT, item: "mission_git: files outside the mission folders, world and .conf pairs, metas", status: other.length ? "warn" : "pass", detail: other.join("; ") || undefined });
  } else {
    rows.push({ section: SUBMIT, item: "mission_git (branch, release, commits, handler files)", status: "not run", detail: gitError });
  }

  if (world) {
    try {
      const notes = missionNames(config, { action: "check", world, ...roots }).split("\n").filter((l) => /^WARNING /.test(l));
      rows.push({ section: SUBMIT, item: "Names follow plugin 6 (world, .conf, in-game name, branch)", status: notes.length ? "fail" : "pass", detail: notes.map((l) => l.slice(8)).join("; ") || undefined });
    } catch (e) {
      rows.push({ section: SUBMIT, item: "Names follow plugin 6 (world, .conf, in-game name, branch)", status: "not run", detail: errorText(e) });
    }

    // CI runs these with --base-ref on the pushed branch; before the push the world may be uncommitted, so check the world itself
    const v = await toolHandler(registerMissionValidate, config)({ world, checks: ["qa", "synopsis", "resources"], ...roots }).catch((e) => ({ content: [{ text: errorText(e) }], isError: true }));
    const vt = v.content[0].text;
    const qa = /\((\d+) failures, (\d+) warnings/.exec(vt);
    const res = /(\d+) resource problems/.exec(vt);
    const ticks = /PR automated checks: (\d+)\/(\d+) ticked/.exec(vt);
    const errs = vt.split("### Errors")[1]?.trim().replace(/\n- /g, "; ").replace(/^- /, "");
    rows.push(qa
      ? { section: SUBMIT, item: "Mission QA (validate_mission.py, as CI)", status: +qa[1] ? "fail" : +qa[2] ? "warn" : "pass", detail: `${qa[1]} failures, ${qa[2]} warnings` }
      : { section: SUBMIT, item: "Mission QA (validate_mission.py, as CI)", status: "not run", detail: errs ?? vt.split("\n")[0] });
    rows.push(res
      ? { section: SUBMIT, item: "Resource integrity (validate_resources.py, as CI)", status: +res[1] ? "fail" : "pass", detail: `${res[1]} problems` }
      : { section: SUBMIT, item: "Resource integrity (validate_resources.py, as CI)", status: "not run", detail: errs ?? vt.split("\n")[0] });
    rows.push(ticks
      ? { section: PR, item: "Automatic boxes: mission file, .conf, play area and markers, briefings", status: ticks[1] === ticks[2] ? "pass" : "fail", detail: `${ticks[1]}/${ticks[2]} ticked${ticks[1] === ticks[2] ? "" : `; open: ${vt.split("\n").filter((l) => l.startsWith("- [ ]")).map((l) => l.slice(6)).join("; ")}`}` }
      : { section: PR, item: "Automatic boxes: mission file, .conf, play area and markers, briefings", status: "not run", detail: errs ?? vt.split("\n")[0] });

    const ins = await toolHandler(registerMissionInspect, config)({ world, sections: ["sides", "rules"], format: "json", ...roots });
    if (ins.isError) rows.push({ section: SUBMIT, item: "mission_inspect rules", status: "not run", detail: ins.content[0].text });
    else {
      const j = JSON.parse(ins.content[0].text) as { rules: { level: string; text: string }[]; sideWarnings: string[] };
      const bad = j.rules.filter((r) => r.level !== "info");
      rows.push({ section: SUBMIT, item: "mission_inspect rules (COA_Lobby name, AI World, .conf, avoid-list compositions)", status: bad.some((r) => r.level === "error") ? "fail" : bad.length ? "warn" : "pass", detail: bad.map((r) => r.text).join("; ") || undefined });
      sideWarnings = j.sideWarnings;
    }
  } else {
    for (const item of ["Names follow plugin 6", "Mission QA, resources and automatic PR boxes", "mission_inspect rules"]) rows.push({ section: SUBMIT, item, status: "not run", detail: `${noWorld}; pass world` });
  }

  // Before you submit [p17]: what only a play test shows
  rows.push(
    { section: BEFORE, item: "Slot in as each side: slotting menu, factions and ratios", status: "in game" },
    { section: BEFORE, item: "Read every side's briefing in game", status: "in game" },
    { section: BEFORE, item: "Spawn in: each side's gearscript and safe start zone", status: "in game", detail: sideWarnings.length ? `files: ${sideWarnings.join("; ")}` : undefined },
    { section: BEFORE, item: "Play every objective through to a win for each side", status: "in game" },
    { section: BEFORE, item: "Check map markers and the play area border for each side", status: "in game" },
    { section: BEFORE, item: "Join in progress with Start only clients", status: "in game" },
  );
  const log = await newestWorkbenchErrors(config);
  rows.push(log
    ? { section: BEFORE, item: "Logs: no script errors", status: log.errors || log.vme ? "fail" : "pass", detail: `${log.text} Read the Dedicated Server Tool's logs too.` }
    : { section: BEFORE, item: "Logs: no script errors", status: "not run", detail: "No Workbench session log found" });

  rows.push({ section: PR, item: "Gearscripts tested in game", status: "in game" });
  rows.push({ section: PR, item: "Faction(s), Objectives and the briefing screenshot filled in", status: "you", detail: "mission_pr_draft drafts the text" });

  const auto = rows.filter((r) => r.status !== "in game" && r.status !== "you");
  return { rows, world, verdict: auto.some((r) => r.status === "fail" || r.status === "not run") ? "no-go" : "go" };
}

const MARK: Record<RowStatus, string> = { pass: "[pass]", fail: "[FAIL]", warn: "[warn]", "not run": "[not run]", "in game": "[in game]", you: "[you]" };

export function formatPreflight(r: Awaited<ReturnType<typeof missionPreflight>>): string {
  const out = [`# Preflight ${r.world ?? "(no world)"}: ${r.verdict.toUpperCase()}`, "Automatic rows decide the verdict; [in game] and [you] rows are always yours to do."];
  for (const section of [BEFORE, SUBMIT, PR]) {
    out.push("", `## ${section}`, ...r.rows.filter((x) => x.section === section).map((x) => `- ${MARK[x.status]} ${x.item}${x.detail ? `: ${x.detail}` : ""}`));
  }
  const open = r.rows.filter((x) => x.status === "in game" || x.status === "you").length;
  out.push("", `${r.rows.filter((x) => x.status === "fail").length} failed, ${r.rows.filter((x) => x.status === "warn").length} warnings, ${r.rows.filter((x) => x.status === "not run").length} not run, ${open} for you in game or in the PR. Read-only.`);
  return out.join("\n");
}

export function registerMissionPreflight(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_preflight",
    {
      description:
        "One go/no-go before you push a mission branch: runs mission_git, mission_names check, mission_validate (qa, synopsis, " +
        "resources on the mission world), mission_inspect rules and the newest Workbench log, then prints the guide's Before You " +
        "Submit and pull request checklists with each row marked pass, FAIL, warn, not run, in game or you. Read-only; never fetches, " +
        "commits, pushes or posts.",
      inputSchema: {
        world: z.string().optional().describe("Mission world (.ent), CRF-relative or absolute (default: the one world the branch changes)"),
        crfPath: z.string().optional().describe("CRF clone inside the project path, or a git worktree of one (default: found under the project path)"),
        lobbyPath: z.string().optional().describe("COALITION-Lobby clone (default: CRF's sibling; a junction to the Lobby clone beside a worktree CRF works)"),
        base: z.string().optional().describe("Ref for mission_git (default origin/release)"),
        format: z.enum(["markdown", "json"]).optional().describe("Default markdown"),
      },
    },
    async ({ format, ...opts }) => {
      try {
        const r = await missionPreflight(config, opts);
        return { content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(r, null, 1) : formatPreflight(r) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    }
  );
}
