import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { git, gitOrNull } from "../release/git.js";
import { resolveCoalitionRoots } from "../utils/coalition-paths.js";

export type FileGroup = "world" | "conf" | "gearscripts" | "prefabs" | "other";
export interface ChangedFile { path: string; status: string; where: ("committed" | "uncommitted" | "untracked")[]; group: FileGroup }
export interface MissionGit {
  crf: string;
  branch: string;
  base: string;
  baseCommit: string;
  ahead: number;
  behind: number;
  /** When the clone last fetched (FETCH_HEAD mtime), null if never */
  fetchedAt: string | null;
  fetched: boolean;
  files: ChangedFile[];
  warnings: string[];
}
export interface MissionGitOptions { crfPath?: string; lobbyPath?: string; base?: string; fetch?: boolean }

const GROUPS: [FileGroup, RegExp][] = [
  ["world", /^Worlds\//i],
  ["conf", /^Missions\/.+\.conf(\.meta)?$/i],
  ["gearscripts", /^Configs\/Gearscripts\//i],
  ["prefabs", /^Prefabs[^/]*\//i],
];
const HANDLERS = /^Scripts\/WorkbenchGame\/EnfusionMCP(\/|\.meta$)/i;
const NEEDS_META = /\.(et|conf|ent|emat|edds|xob|layout)$/i;
const WORLD_REF = /^\s*World\s+"\{[0-9A-Fa-f]{16}\}([^"]+)"/m;
const list = (xs: string[], n = 10) => xs.slice(0, n).join(", ") + (xs.length > n ? `, and ${xs.length - n} more` : "");

/** A caller's ref as a commit id: never passed to git as typed, so "--output=..." cannot become an option. */
export function resolveCommit(dir: string, ref: string): string | null {
  return ref.startsWith("-") ? null : gitOrNull(dir, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]);
}

function missionConfs(crf: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(crf, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (/\.conf$/i.test(e.name)) out.push(`${rel}/${e.name}`);
    }
  };
  if (existsSync(join(crf, "Missions"))) walk("Missions");
  return out;
}

/** Read-only branch and change report for a mission branch in a CRF clone (git without optional locks; fetch only when asked). */
export function missionGit(config: Config, opts: MissionGitOptions = {}): MissionGit {
  const { crf } = resolveCoalitionRoots(config, opts.crfPath, opts.lobbyPath);
  const top = gitOrNull(crf, ["rev-parse", "--show-toplevel"]);
  if (!top || resolve(top).toLowerCase() !== resolve(crf).toLowerCase()) throw new Error(`${crf} is not a git clone of its own.`);
  // Fetching writes refs and FETCH_HEAD, so it runs only when the caller asks
  if (opts.fetch) git(crf, ["fetch", "origin", "release"]);
  const base = opts.base ?? "origin/release";
  const baseCommit = resolveCommit(crf, base);
  if (!baseCommit) throw new Error(`${base} is not a commit in ${crf}. Fetch release first (fetch: true) or pass base.`);

  const branch = gitOrNull(crf, ["branch", "--show-current"]) || "(detached)";
  const [behind, ahead] = (gitOrNull(crf, ["rev-list", "--left-right", "--count", `${baseCommit}...HEAD`]) ?? "0 0").split(/\s+/).map(Number);
  const fetchHead = resolve(crf, git(crf, ["rev-parse", "--git-path", "FETCH_HEAD"]).trim());
  const fetchedAt = existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : null;

  const files = new Map<string, ChangedFile>();
  const add = (path: string, status: string, where: ChangedFile["where"][number]) => {
    const f = files.get(path);
    if (f) f.where.push(where);
    else files.set(path, { path, status, where: [where], group: GROUPS.find(([, re]) => re.test(path))?.[0] ?? "other" });
  };
  const diff = git(crf, ["diff", "--name-status", "--no-renames", "-z", `${baseCommit}...HEAD`]).split("\0");
  for (let i = 0; i + 1 < diff.length; i += 2) if (diff[i]) add(diff[i + 1], diff[i], "committed");
  const status = git(crf, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < status.length; i++) {
    const e = status[i];
    if (!e) continue;
    if (e.startsWith("??")) add(e.slice(3), "A", "untracked");
    else add(e.slice(3), e.slice(0, 2).trim(), "uncommitted");
    if (/^[RC]/.test(e)) i++; // a rename or copy is followed by its source path
  }

  const warnings: string[] = [];
  if (!branch.startsWith("mission/")) warnings.push(`Branch ${branch} is not mission/<name>: CRF's Mission QA checklist job runs only on mission/ branches (validate.yml)`);
  if (behind) warnings.push(`${behind} commits behind ${base}: update the branch from release before you push`);
  const changed = [...files.values()];
  const live = changed.filter((f) => f.status !== "D");
  const handlers = live.filter((f) => HANDLERS.test(f.path)).map((f) => f.path);
  if (handlers.length) warnings.push(`MCP handler files in the change: ${list(handlers)} (run wb_cleanup; never commit them)`);
  const outside = live.filter((f) => f.group === "other" && !HANDLERS.test(f.path)).map((f) => f.path);
  if (outside.length) warnings.push(`Files outside the mission folders (Worlds, Missions, Configs/Gearscripts, Prefabs): ${list(outside)}`);

  const confs = missionConfs(crf).map((c) => ({ conf: c, world: readFileSync(join(crf, c), "utf-8").match(WORLD_REF)?.[1] }));
  for (const w of live.filter((f) => /^Worlds\/.+\.ent$/i.test(f.path))) {
    if (!confs.some((c) => c.world?.toLowerCase() === w.path.toLowerCase())) warnings.push(`World ${w.path} has no mission .conf in Missions/ (plugin 6 not run?)`);
  }
  for (const c of live.filter((f) => f.group === "conf" && /\.conf$/i.test(f.path))) {
    const world = confs.find((x) => x.conf.toLowerCase() === c.path.toLowerCase())?.world;
    if (world && !existsSync(join(crf, world))) warnings.push(`${c.path} points at ${world}, which does not exist`);
  }
  const noMeta = live.filter((f) => f.status === "A" && NEEDS_META.test(f.path) && !existsSync(join(crf, `${f.path}.meta`))).map((f) => f.path);
  if (noMeta.length) warnings.push(`New resources without a .meta: ${list(noMeta)} (register them in Workbench)`);

  return { crf, branch, base, baseCommit, ahead, behind, fetchedAt, fetched: !!opts.fetch, files: changed, warnings };
}

/** The one mission world (.ent) the branch adds or changes, a changed layer counting for its world; throws asking for world when there are none or several. */
export function changedWorld(r: MissionGit): string {
  const worlds = [...new Set(r.files.filter((f) => f.status !== "D").map((f) => f.path.replace(/_Layers\/[^/]+\.layer$/i, ".ent")).filter((p) => /^Worlds\/.+\.ent$/i.test(p)))];
  if (worlds.length !== 1) throw new Error(worlds.length ? `Several worlds changed (${worlds.join(", ")}): pass world.` : `No world changed against ${r.base}: pass world.`);
  return worlds[0];
}

export function formatMissionGit(r: MissionGit): string {
  const age = r.fetchedAt ? `${((Date.now() - Date.parse(r.fetchedAt)) / 3_600_000).toFixed(1)} h ago (${r.fetchedAt})` : "never";
  const out = [
    `# Mission branch ${r.branch}`,
    r.crf,
    "",
    `- Against ${r.base} (${r.baseCommit.slice(0, 8)}): ${r.ahead} ahead, ${r.behind} behind`,
    `- Last fetch: ${age}${r.fetched ? " (fetched by this call)" : "; counts are as of then"}`,
  ];
  const titles: [FileGroup, string][] = [["world", "World and layers"], ["conf", "Mission .conf"], ["gearscripts", "Gearscripts"], ["prefabs", "Prefabs"], ["other", "Other"]];
  out.push("", `## Changed files (${r.files.length})`);
  if (!r.files.length) out.push("- none");
  for (const [g, title] of titles) {
    const fs = r.files.filter((f) => f.group === g);
    if (fs.length) out.push(`### ${title} (${fs.length})`, ...fs.map((f) => `- ${f.status} ${f.path} (${f.where.join(", ")})`));
  }
  out.push("", "## Warnings", ...(r.warnings.length ? r.warnings.map((w) => `- ${w}`) : ["- none"]));
  out.push("", `Read-only${r.fetched ? ", except the fetch you asked for" : ""}. Status, refs and files unchanged.`);
  return out.join("\n");
}

export function registerMissionGit(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_git",
    {
      description:
        "Read-only branch and change report for a mission branch in a CRF clone: current branch (warns unless mission/<name>), " +
        "commits ahead and behind origin/release as of the last fetch, files changed against it grouped as world and layers, " +
        ".conf, gearscripts, prefabs and other, and warnings for MCP handler files, files outside the mission folders, a world " +
        "without a .conf or the reverse, and new resources without a .meta. fetch: true runs git fetch origin release first (writes refs).",
      inputSchema: {
        crfPath: z.string().optional().describe("CRF clone inside the project path (default: found under the project path)"),
        lobbyPath: z.string().optional().describe("COALITION-Lobby clone (default: CRF's sibling)"),
        base: z.string().optional().describe("Ref to compare with (default origin/release)"),
        fetch: z.boolean().optional().describe("Run git fetch origin release first; writes refs, so only when the user asks"),
        format: z.enum(["markdown", "json"]).optional().describe("Default markdown"),
      },
    },
    async ({ format, ...opts }) => {
      try {
        const r = missionGit(config, opts);
        return { content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(r, null, 1) : formatMissionGit(r) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    }
  );
}
