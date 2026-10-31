import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { gitRevision, resolveCoalitionRoots } from "../utils/coalition-paths.js";
import { findPython, type PythonCommand } from "../utils/python.js";
import { validateProjectPath } from "../utils/safe-path.js";

// -I ignores PYTHON* env vars and user site-packages; -B keeps __pycache__ out of the CRF
// clone (-I would also ignore PYTHONDONTWRITEBYTECODE); -X utf8 forces UTF-8 stdout.
const PY_FLAGS = ["-I", "-B", "-X", "utf8"];
const TIMEOUT_MS = 120_000;

const SCRIPTS = {
  qa: "validate_mission.py",
  synopsis: "mission_synopsis.py",
  resources: "validate_resources.py",
} as const;
type Check = keyof typeof SCRIPTS;

// ── Parsers (pure) ──────────────────────────────────────────────────────────

export type QaKind = "ok" | "fail" | "warn" | "info" | "other";
export interface QaItem {
  world?: string;
  section?: string;
  kind: QaKind;
  text: string;
}
export interface QaReport {
  items: QaItem[];
  totals?: { failures: number; warnings: number; worlds: number };
}

const QA_KINDS: Record<string, QaKind> = { "[OK]": "ok", "[X]": "fail", "[!]": "warn", "[-]": "info" };

/** validate_mission.py stdout: "# <world>" headers, "## <section>" headings, [OK]/[X]/[!]/[-] lines, a totals line. */
export function parseQaReport(stdout: string): QaReport {
  const report: QaReport = { items: [] };
  let world: string | undefined;
  let section: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("Scanned: ")) continue;
    const totals = /^(\d+) failure\(s\), (\d+) warning\(s\) across (\d+) world\(s\)\.$/.exec(line);
    if (totals) {
      report.totals = { failures: Number(totals[1]), warnings: Number(totals[2]), worlds: Number(totals[3]) };
    } else if (line.startsWith("# ")) {
      world = line.slice(2).replace(/\s+\(entity in .*\)$/, "");
      section = undefined;
    } else if (line.startsWith("## ")) {
      section = line.slice(3);
    } else {
      // Unknown lines are kept as "other" so a format change in CRF drops nothing.
      const m = /^(\[OK\]|\[X\]|\[!\]|\[-\]) (.*)$/.exec(line);
      report.items.push({ world, section, kind: m ? QA_KINDS[m[1]] : "other", text: m ? m[2] : line });
    }
  }
  return report;
}

const CHECKS_START = "<!-- CRF_CHECKS_START -->";
const CHECKS_END = "<!-- CRF_CHECKS_END -->";
const SYNOPSIS_START = "<!-- CRF_SYNOPSIS_START -->";
const SYNOPSIS_END = "<!-- CRF_SYNOPSIS_END -->";

export interface SynopsisReport {
  title?: string;
  /** The PR "Automated Checks" block, markers included. */
  checks?: string;
  ticked: number;
  total: number;
  /** The synopsis block exactly as printed, markers included (the bot parses it byte for byte). */
  synopsis?: string;
}

function markedBlock(text: string, start: string, end: string): string | undefined {
  const i = text.indexOf(start);
  const j = i < 0 ? -1 : text.indexOf(end, i);
  return j < 0 ? undefined : text.slice(i, j + end.length);
}

/** mission_synopsis.py stdout (no --out-dir): "Title: ..." line, the checks block, the synopsis block. */
export function parseSynopsis(stdout: string): SynopsisReport {
  const checks = markedBlock(stdout, CHECKS_START, CHECKS_END);
  const boxes = (re: RegExp) => checks?.match(re)?.length ?? 0;
  return {
    title: /^Title: (.*)$/m.exec(stdout)?.[1],
    checks,
    ticked: boxes(/^- \[x\]/gm),
    total: boxes(/^- \[[ x]\]/gm),
    synopsis: markedBlock(stdout, SYNOPSIS_START, SYNOPSIS_END),
  };
}

export interface ResourceCheck {
  name: string;
  ok: boolean;
  failures: string[];
}
export interface ResourcesReport {
  checks: ResourceCheck[];
  problems?: number;
}

/** validate_resources.py stdout: "[FAIL] name - ..." / "[  ok] name - ..." headers, indented failures, a totals line. */
export function parseResources(stdout: string): ResourcesReport {
  const report: ResourcesReport = { checks: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const head = /^\[(FAIL|  ok)\] (\S+) - /.exec(line);
    const total = /^(\d+) problem\(s\) found\.$/.exec(line);
    if (head) report.checks.push({ name: head[2], ok: head[1] !== "FAIL", failures: [] });
    else if (total) report.problems = Number(total[1]);
    else if (line === "All checks passed.") report.problems = 0;
    else if (/^\s+\S/.test(line) && report.checks.length) report.checks[report.checks.length - 1].failures.push(line.trim());
  }
  return report;
}

// ── Running the scripts ─────────────────────────────────────────────────────

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function runScript(py: PythonCommand, crf: string, script: string, args: string[]): Promise<ScriptRun> {
  const started = Date.now();
  return new Promise((done, fail) => {
    execFile(
      py.cmd,
      [...py.args, ...PY_FLAGS, join(crf, "Tools", "Validation", script), ...args],
      { cwd: crf, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf-8" },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        if (!err) done({ code: 0, stdout, stderr, ms });
        else if (typeof err.code === "number" && !err.killed) done({ code: err.code, stdout, stderr, ms });
        else if (err.killed && typeof err.code !== "string") fail(new Error(`${script} did not finish in ${TIMEOUT_MS / 1000} s.`));
        else fail(err);
      }
    );
  });
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop()?.trim() ?? "";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Params {
  world?: string;
  baseRef?: string;
  checks: Check[];
  crfPath?: string;
  lobbyPath?: string;
  extraRoots: string[];
  verbose: boolean;
}

async function missionValidate(config: Config, p: Params): Promise<{ text: string; isError: boolean }> {
  if (!p.world === !p.baseRef) throw new Error("Pass exactly one of world or baseRef.");
  const { crf, lobby } = resolveCoalitionRoots(config, p.crfPath, p.lobbyPath);

  let target: string[];
  let label: string;
  if (p.world) {
    let abs: string;
    try {
      abs = validateProjectPath(crf, p.world);
    } catch {
      throw new Error(
        `World must be inside the CRF clone; the validator only finds mission .conf files in ${join(crf, "Missions", "<Terrain>")}.`
      );
    }
    if (!existsSync(abs)) throw new Error(`World not found: ${abs}`);
    target = ["--world", abs];
    label = relative(crf, abs).replaceAll("\\", "/");
  } else {
    target = ["--base-ref", p.baseRef!];
    label = `worlds changed against ${p.baseRef}`;
  }

  const extra = p.extraRoots.map((r) => resolve(r));
  const missing = extra.filter((r) => !existsSync(r));
  if (missing.length) throw new Error(`extraRoots not found: ${missing.join(", ")}`);

  const py = findPython();
  if (!py) throw new Error("Python 3 not found. Set ENFUSION_PYTHON to python.exe, or install Python 3.11+.");

  // Same arguments as CRF's CI; never --out-dir or --pr-json, which write files.
  const projectArgs = [lobby, ...extra].flatMap((r) => ["--project", r]);
  const checks = [...new Set(p.checks)];
  const settled = await Promise.allSettled(
    checks.map((c) => runScript(py, crf, SCRIPTS[c], c === "resources" ? projectArgs : [...projectArgs, ...target]))
  );

  const got: Partial<Record<Check, ScriptRun>> = {};
  const errors: string[] = [];
  const ran: string[] = [];
  checks.forEach((c, i) => {
    const s = settled[i];
    if (s.status === "rejected") return void errors.push(`${SCRIPTS[c]}: ${errorText(s.reason)}`);
    const r = s.value;
    ran.push(`${SCRIPTS[c]} (${r.ms} ms)`);
    // Exit 1 means "failures found" for qa and resources, but a Python crash also exits 1.
    const crashed = /^Traceback \(most recent call last\)/m.test(r.stderr);
    if (!crashed && (r.code === 0 || (r.code === 1 && c !== "synopsis"))) got[c] = r;
    else errors.push(`${SCRIPTS[c]} exited with code ${r.code}: ${lastLine(r.stderr) || "no error output"}`);
  });

  const qa = got.qa && parseQaReport(got.qa.stdout);
  const syn = got.synopsis && parseSynopsis(got.synopsis.stdout);
  const res = got.resources && parseResources(got.resources.stdout);
  const resProblems = res && (res.problems ?? res.checks.reduce((n, c) => n + c.failures.length, 0));

  const counts: string[] = [];
  let failed = false;
  if (qa) {
    const count = (k: QaKind) => qa.items.filter((i) => i.kind === k).length;
    const failures = qa.totals?.failures ?? count("fail");
    const warnings = qa.totals?.warnings ?? count("warn");
    counts.push(qa.totals ? `${failures} failures, ${warnings} warnings` : p.baseRef ? `nothing changed against ${p.baseRef}` : "nothing to check");
    failed ||= got.qa!.code === 1 || failures > 0;
  }
  if (res) {
    counts.push(`${resProblems} resource problems`);
    failed ||= got.resources!.code === 1 || resProblems! > 0;
  }
  const verdict = errors.length ? "ERROR" : failed ? "FAIL" : "PASS";

  const out = [`**Mission check: ${label}**  ${verdict}${counts.length ? ` (${counts.join(", ")})` : ""}`];
  if (syn) {
    if (syn.title === undefined) out.push(`mission_synopsis.py: ${got.synopsis!.stdout.trim()}`);
    else out.push(`Title CI will set: ${syn.title}`);
    if (syn.checks) {
      out.push(`PR automated checks: ${syn.ticked}/${syn.total} ticked`);
      out.push(...syn.checks.split(/\r?\n/).filter((l) => l.startsWith("- [ ]")));
    }
  }

  if (qa) {
    const multiWorld = (qa.totals?.worlds ?? 1) > 1;
    const list = (kind: QaKind, heading: string) => {
      const items = qa.items.filter((i) => i.kind === kind);
      if (!items.length) return;
      out.push("", `### ${heading} (${items.length})`);
      for (const i of items) {
        const where = [multiWorld ? i.world : undefined, i.section].filter(Boolean).join(" / ");
        out.push(`- ${where ? `[${where}] ` : ""}${i.text}`);
      }
    };
    list("fail", "Failures (validate_mission.py)");
    list("warn", "Warnings (validate_mission.py)");
    list("info", "Not verifiable offline");
    list("other", "Other output (validate_mission.py)");
    if (p.verbose) list("ok", "Passed");
  }

  if (res) {
    out.push("", `### Resource integrity (validate_resources.py): ${resProblems} problems`);
    for (const c of res.checks) {
      if (c.ok && !p.verbose) continue;
      out.push(`- ${c.ok ? "ok" : "FAIL"} ${c.name}`, ...c.failures.map((f) => `  - ${f}`));
    }
  }

  if (syn?.synopsis) out.push("", "### Synopsis (what the PR bot posts)", syn.synopsis);
  if (errors.length) out.push("", "### Errors", ...errors.map((e) => `- ${e}`));
  out.push("", `Ran: ${ran.join(", ") || "nothing"} with python ${py.version}, CRF @ ${gitRevision(crf)}, Lobby @ ${gitRevision(lobby)}`);

  return { text: out.join("\n"), isError: errors.length > 0 };
}

export function registerMissionValidate(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_validate",
    {
      description:
        "Run COALITION CRF's own mission checks offline, the same scripts CI runs on every mission PR: " +
        "validate_mission.py (mission QA), mission_synopsis.py (PR title, automated check ticks, synopsis) and " +
        "validate_resources.py (resource integrity across CRF and Lobby). Returns a verdict, then failures, warnings " +
        "and the synopsis. Read-only and no Workbench needed: it executes the Python scripts in place from the CRF " +
        "clone inside the project path (python -I -B -X utf8) and writes nothing.",
      inputSchema: {
        world: z
          .string()
          .optional()
          .describe("Mission world, CRF-relative (e.g. 'Worlds/Arland/MyMission.ent') or absolute. Must be inside the CRF clone. Pass this or baseRef."),
        baseRef: z
          .string()
          .regex(/^(?!-)[\w./@{}^~-]+$/, "Must be a git ref such as origin/release")
          .optional()
          .describe("Git ref to diff against (e.g. 'origin/release'): checks the worlds the current CRF branch adds or changes, like CI. Pass this or world."),
        checks: z
          .array(z.enum(["qa", "synopsis", "resources"]))
          .min(1)
          .default(["qa", "synopsis"])
          .describe("Scripts to run. 'resources' scans both whole repos (slower, PR-wide). Default: qa and synopsis."),
        crfPath: z
          .string()
          .optional()
          .describe("CRF clone. Default: ENFUSION_DEFAULT_MOD if it holds Tools/Validation/validate_mission.py, else the first project folder that does. Must be inside the project path."),
        lobbyPath: z
          .string()
          .optional()
          .describe("COALITION-Lobby clone. Default: the COALITION-Lobby folder next to the CRF clone. Must be inside the project path."),
        extraRoots: z
          .array(z.string())
          .default([])
          .describe("Extra --project roots, e.g. an extracted vanilla data folder so vanilla magazine wells resolve. Each must exist."),
        verbose: z.boolean().default(false).describe("Also list passed checks."),
      },
    },
    async (params) => {
      try {
        const { text, isError } = await missionValidate(config, params);
        return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    }
  );
}
