import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { buildStack, closure, rdbOf } from "../pak/stack.js";
import {
  checkGit, checkGprojFindings, checkHandlers, checkLeftovers, checkMeta, checkOverrides, checkPreview, checkSize, checkText,
  type Check, type Finding, type GuidOwners, type Level, type Sizes,
} from "../release/checks.js";
import { gitState } from "../release/git.js";
import { walkAddon } from "../release/scan.js";
import { forbiddenRoot } from "../utils/safe-path.js";
import { readGproj, resolveGproj } from "../workbench/cli.js";

const CHECKS = ["handlers", "git", "gproj", "meta", "leftovers", "text", "size", "preview", "overrides"] as const;

export interface AuditOptions {
  addonName?: string;
  gprojPath?: string;
  previewImage?: string;
  checks?: (typeof CHECKS)[number][];
  gitBase?: string;
  compareOverrides?: boolean;
}

export interface AuditJson {
  addon: string;
  dir: string;
  verdict: "blocked" | "warnings" | "clean";
  counts: Record<Level, number>;
  findings: (Omit<Finding, "path" | "fix"> & { path: string | null; fix: string | null })[];
  sizes: Sizes | null;
}

/** GUIDs the addon's dependency closure (base game included) declares, from each dependency's rdb. */
function dependencyOwners(config: Config, gproj: string): GuidOwners {
  const owners: GuidOwners = new Map();
  for (const a of closure(config, gproj).order.slice(0, -1)) {
    for (const e of rdbOf(a.dir).values()) if (!owners.has(e.guid)) owners.set(e.guid, { path: e.path, addon: a.name || a.title || a.id });
  }
  return owners;
}

/** Read-only release report for one addon: never writes, never starts Workbench, git without optional locks. */
export function releaseAudit(config: Config, opts: AuditOptions = {}): { report: string; json: AuditJson } | { error: string } {
  const gproj = resolveGproj(config, opts.addonName ?? config.defaultMod, opts.gprojPath);
  if (!gproj) return { error: `Addon not found. Pass addonName (a folder under ${config.projectPath}) or gprojPath.` };
  const dir = dirname(gproj);
  const findings: Finding[] = [];
  let sizes: Sizes | null = null;

  const root = forbiddenRoot(config, dir);
  if (root) {
    findings.push({ id: "X1", level: "blocker", check: "root", message: `${dir} is inside ${root}; not audited`, fix: "Work on a clone under the projects folder" });
  } else {
    const want = new Set<Check>(opts.checks ?? CHECKS);
    const run = (check: Check, fn: () => Finding[]) => {
      if (!want.has(check)) return;
      try {
        findings.push(...fn());
      } catch (e) {
        // A git check that could not run is a blocker: its G1, G2 and G5 findings are exactly what a warning would hide.
        findings.push({ id: "U1", level: check === "git" ? "blocker" : "warning", check, message: `${check} check failed: ${(e as Error).message}` });
      }
    };
    const scan = walkAddon(dir);
    for (const rel of scan.unreadable) findings.push({ id: "U1", level: "warning", check: "size", path: rel, message: "Unreadable file" });
    run("handlers", () => checkHandlers(dir));
    run("git", () => checkGit(gitState(dir, opts.gitBase)));
    run("gproj", () => checkGprojFindings(dir));
    run("meta", () => {
      let owners: GuidOwners | undefined;
      const skipped: Finding[] = [];
      try {
        owners = dependencyOwners(config, gproj);
      } catch (e) {
        skipped.push({ id: "M5", level: "info", check: "meta", message: `Dependency GUIDs not read (${(e as Error).message}); clash check skipped` });
      }
      const rdb = existsSync(join(dir, "resourceDatabase.rdb")) ? rdbOf(dir) : null;
      return [...skipped, ...checkMeta(dir, scan, rdb, owners)];
    });
    run("leftovers", () => checkLeftovers(dir, scan));
    run("text", () => checkText(dir, scan));
    run("size", () => {
      const s = checkSize(scan);
      sizes = s.sizes;
      return s.findings;
    });
    run("preview", () => checkPreview(dir, scan, opts.previewImage));
    if (opts.compareOverrides) run("overrides", () => checkOverrides(dir, scan, buildStack(config, gproj).layers.slice(0, -1)));
  }

  const counts = { blocker: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  const json: AuditJson = {
    addon: readGproj(gproj).id || dir,
    dir,
    verdict: counts.blocker ? "blocked" : counts.warning ? "warnings" : "clean",
    counts,
    findings: findings.map((f) => ({ ...f, path: f.path ?? null, fix: f.fix ?? null })),
    sizes,
  };
  return { report: formatReport(json, root ? [] : [...new Set<Check>(opts.checks ?? CHECKS)].filter((c) => c !== "overrides" || opts.compareOverrides)), json };
}

function formatReport(j: AuditJson, ran: Check[]): string {
  const lines = [`# Release audit: ${j.addon}`, j.dir, "", `Verdict: **${j.verdict}** (${j.counts.blocker} blockers, ${j.counts.warning} warnings, ${j.counts.info} info)`];
  const titles: [Level, string][] = [["blocker", "Blockers"], ["warning", "Warnings"], ["info", "Info"]];
  for (const [level, title] of titles) {
    const fs = j.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    lines.push("", `## ${title}`);
    for (const f of fs) lines.push(`- ${f.id}${f.path ? ` ${f.path}` : ""}: ${f.message}${f.fix ? `. Fix: ${f.fix}` : ""}`);
  }
  const passed = ran.filter((c) => !j.findings.some((f) => f.check === c && f.level !== "info"));
  if (passed.length) lines.push("", "## Passed", passed.join(", "));
  lines.push("", "```json", JSON.stringify(j), "```");
  return lines.join("\n");
}

export function registerReleaseAudit(server: McpServer, config: Config): void {
  server.registerTool(
    "release_audit",
    {
      description:
        "Offline, read-only release report for one addon before a commit, test pack or Workshop publish: MCP handler files, git state " +
        "and commit messages, .gproj, meta and resourceDatabase.rdb registration, GUID clashes with dependencies, leftovers, BOM and " +
        "public-text rules, packable size and preview image. Findings have stable IDs (H1, G1, M2...) and a verdict: blocked, warnings or clean. " +
        "Never writes, packs, publishes or starts Workbench.",
      inputSchema: {
        addonName: z.string().optional().describe("Addon folder under the projects path (default ENFUSION_DEFAULT_MOD)"),
        gprojPath: z.string().optional().describe("Path to the addon's .gproj, instead of addonName (for example a test addon)"),
        previewImage: z.string().optional().describe("Planned Workshop preview image (default thumbnail.png, then .github/preview.png in the addon)"),
        checks: z.array(z.enum(CHECKS)).optional().describe("Subset of checks to run (default all; overrides also needs compareOverrides)"),
        gitBase: z.string().optional().describe("Ref for the commit-message scan (default the upstream; without one, commits on no remote branch)"),
        compareOverrides: z.boolean().optional().describe("Compare files that override a dependency path byte for byte (reads dependency paks; slower)"),
        format: z.enum(["text", "json"]).optional().describe("json returns only the JSON block (default text)"),
      },
    },
    async ({ format, ...opts }) => {
      const r = releaseAudit(config, opts);
      if ("error" in r) return { content: [{ type: "text" as const, text: r.error }], isError: true };
      return { content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(r.json, null, 1) : r.report }] };
    }
  );
}
