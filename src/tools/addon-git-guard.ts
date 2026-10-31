import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { handlerFiles, resolveGproj } from "../workbench/cli.js";
import { isProtectedAddon } from "../utils/game-paths.js";
import { forbiddenRoot, isContained, realPathOf } from "../utils/safe-path.js";
import { COMMIT_MSG, STRIPPER_COMMIT_MSG, GUARDED_PATH, HOOK_VERSION, PRE_COMMIT, ourVersion } from "../release/hooks.js";
import { gitOrNull, hooksDir, originUrl, stagedPaths, stagedStartsWithBom } from "../release/git.js";

type HookName = "pre-commit" | "commit-msg";
const TEMPLATES: Record<HookName, string> = { "pre-commit": PRE_COMMIT, "commit-msg": COMMIT_MSG };

export interface GuardFinding {
  id: "G2" | "T1";
  severity: "blocker";
  path: string;
  message: string;
}

/** The addon's repo root, or an error. Only addons under the projects folder or ENFUSION_ADDONS_DIR, and only when the addon folder is the repo root. */
export function resolveGuardRepo(config: Config, addonName?: string, gprojPath?: string): { dir: string; gproj: string } | { error: string } {
  if (!addonName && !gprojPath) return { error: "Pass addonName (a folder under the projects path) or gprojPath. This tool never falls back to ENFUSION_DEFAULT_MOD." };
  const gproj = resolveGproj(config, addonName, gprojPath);
  if (!gproj) return { error: `No .gproj found for ${gprojPath ?? addonName}.` };
  const dir = dirname(gproj);
  const real = realPathOf(dir);
  const roots = [config.projectPath, ...(config.addonsDir ?? "").split(",")].map((d) => d.trim()).filter(Boolean);
  if (!roots.some((r) => real !== realPathOf(r) && isContained(realPathOf(r), real))) {
    return { error: `Refused: ${dir} is outside the projects folder (${roots.join(", ")}).` };
  }
  const fr = forbiddenRoot(config, dir);
  if (fr) return { error: `Refused: ${dir} is inside ${fr} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS).` };
  const top = gitOrNull(dir, ["rev-parse", "--show-toplevel"]);
  if (!top || realPathOf(top) !== real) return { error: `${dir} is not a git repository; nothing to guard.` };
  return { dir, gproj };
}

/** The guard rules on the staged index, exactly as the pre-commit hook applies them. */
export function guardCheck(dir: string): GuardFinding[] {
  const guarded = new RegExp(GUARDED_PATH, "i");
  const findings: GuardFinding[] = [];
  for (const p of stagedPaths(dir)) {
    if (guarded.test(p)) findings.push({ id: "G2", severity: "blocker", path: p, message: `${p} is staged (MCP handler file or resourceDatabase.rdb)` });
    if (p.endsWith(".c") && stagedStartsWithBom(dir, p)) {
      findings.push({ id: "T1", severity: "blocker", path: p, message: `${p} starts with a UTF-8 BOM (Enforce rejects it)` });
    }
  }
  return findings;
}

function hookState(file: string, name: HookName): string {
  if (!existsSync(file)) return "none";
  const text = readFileSync(file, "utf-8");
  const v = ourVersion(text);
  if (v !== null) return `ours v${v}`;
  if (name === "commit-msg" && text.replace(/\r\n/g, "\n") === STRIPPER_COMMIT_MSG) return "attribution stripper";
  return `foreign (${text.split(/\r?\n/)[0]})`;
}

/** Write our hooks into the repo's hooks folder. Refuses, before writing anything, on core.hooksPath, a non-SyykoNT origin without sharedRepoOk, or a foreign pre-commit. */
export function guardInstall(dir: string, opts: { hooks?: HookName[]; sharedRepoOk?: boolean } = {}): { ok: boolean; lines: string[] } {
  const hooksPath = gitOrNull(dir, ["config", "--get", "core.hooksPath"]);
  if (hooksPath) return { ok: false, lines: [`core.hooksPath is set (${hooksPath}); hooks in .git/hooks would not run. Nothing written.`] };
  const origin = originUrl(dir);
  if (origin && !/github\.com[/:]SyykoNT\//i.test(origin) && !opts.sharedRepoOk) {
    return {
      ok: false,
      lines: [`${basename(dir)} is a shared repo (origin ${origin}). Ask the user before installing a local hook there; then call again with sharedRepoOk: true. Nothing written.`],
    };
  }
  const hdir = hooksDir(dir);
  const plan: [HookName, string, string | null][] = (opts.hooks ?? ["pre-commit", "commit-msg"]).map((h) => {
    const file = join(hdir, h);
    return [h, file, existsSync(file) ? readFileSync(file, "utf-8") : null];
  });
  const foreign = plan.find(([h, , t]) => h === "pre-commit" && t !== null && ourVersion(t) === null);
  if (foreign) return { ok: false, lines: [`A foreign pre-commit exists (${foreign[2]!.split(/\r?\n/)[0]}); left alone. Nothing written.`] };

  const lines: string[] = [];
  mkdirSync(hdir, { recursive: true });
  for (const [h, file, text] of plan) {
    const v = text === null ? null : ourVersion(text);
    if (text !== null && v === null) {
      lines.push(`kept ${h} (${hookState(file, h)}); not ours, left alone`);
    } else if (v !== null && v >= HOOK_VERSION) {
      lines.push(`${h} already v${v}`);
    } else {
      writeFileSync(file, TEMPLATES[h], "utf-8"); // Node writes no BOM; the templates are LF only
      chmodSync(file, 0o755); // no effect on Windows: Git for Windows runs hooks without the exec bit
      lines.push(`wrote ${file} (v${HOOK_VERSION}${v !== null ? `, replaced v${v}` : ""})`);
    }
  }
  return { ok: true, lines };
}

/** One row per git repo among the direct children of the projects folder (plus extra). */
export function guardStatus(config: Config, extra?: string): string[] {
  const dirs = readdirSync(config.projectPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(config.projectPath, e.name, ".git")))
    .map((e) => join(config.projectPath, e.name));
  if (extra && !dirs.some((d) => realPathOf(d) === realPathOf(extra))) dirs.push(extra);
  return dirs.map((d) => {
    const hdir = hooksDir(d);
    const ignored = gitOrNull(d, ["check-ignore", "-q", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c"]) !== null;
    return (
      `${basename(d)}: pre-commit ${hookState(join(hdir, "pre-commit"), "pre-commit")}; ` +
      `commit-msg ${hookState(join(hdir, "commit-msg"), "commit-msg")}; ` +
      `handlers ignored ${ignored ? "yes" : "no"}; handler files on disk ${handlerFiles(d).length}`
    );
  });
}

export function registerAddonGitGuard(server: McpServer, config: Config): void {
  server.registerTool(
    "addon_git_guard",
    {
      description:
        "Git commit guard for addon repos. status: hooks, ignore rule and handler files per repo under the projects folder (read-only). " +
        "check: the guard rules on the staged index now (G2 handler file, folder .meta or resourceDatabase.rdb; T1 .c with a UTF-8 BOM), read-only. " +
        "install: write a local pre-commit guard and, if absent, the attribution-stripping commit-msg hook into <repo>/.git/hooks. " +
        "Only for one named addon; refuses protected addons, repos outside the projects folder, core.hooksPath, foreign pre-commit hooks, " +
        "and non-SyykoNT origins unless sharedRepoOk (set it only after the user says yes for that repo).",
      inputSchema: {
        action: z.enum(["status", "check", "install"]),
        addonName: z.string().optional().describe("Addon folder under the projects path (check/install need this or gprojPath)"),
        gprojPath: z.string().optional().describe("Path to the addon's .gproj, instead of addonName"),
        hooks: z.array(z.enum(["pre-commit", "commit-msg"])).optional().describe("install: which hooks to write (default both)"),
        sharedRepoOk: z.boolean().optional().describe("install: allow a repo whose origin is not a SyykoNT repo, only after the user agrees"),
      },
    },
    async ({ action, addonName, gprojPath, hooks, sharedRepoOk }) => {
      const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) });
      try {
        if (action === "status") {
          let extra: string | undefined;
          if (gprojPath) {
            const r = resolveGuardRepo(config, undefined, gprojPath);
            if ("error" in r) return reply(r.error, true);
            extra = r.dir;
          }
          return reply(guardStatus(config, extra).join("\n") || `No git repos under ${config.projectPath}.`);
        }
        const r = resolveGuardRepo(config, addonName, gprojPath);
        if ("error" in r) return reply(r.error, true);
        if (action === "check") {
          const f = guardCheck(r.dir);
          return reply(f.length ? f.map((x) => `${x.id} ${x.severity} ${x.message}`).join("\n") : `${basename(r.dir)}: nothing staged that the guard refuses.`);
        }
        if (isProtectedAddon(config, r.gproj)) return reply(`Refused: ${basename(r.dir)} is protected (ENFUSION_PROTECTED_ADDONS). Nothing written.`, true);
        const res = guardInstall(r.dir, { hooks, sharedRepoOk });
        return reply(res.lines.join("\n"), !res.ok);
      } catch (e) {
        return reply(`addon_git_guard ${action} failed: ${(e as Error).message}`, true);
      }
    }
  );
}
