/**
 * Log cursor and waits for Workbench, game and server logs: read only the bytes appended since
 * the last call, wait for patterns, extract values, assert on what a run wrote.
 * Polls file size (fs.watch is unreliable for files another process appends to on Windows).
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseScriptIssues } from "../workbench/cli.js";
import { formatLogTime, parseLogHeader, parseLogTime, scriptErrorParser } from "../workbench/script-errors.js";
import { isAlive as processAlive, newestDir, sleep } from "./process.js";
import { isContained, realPathOf } from "./safe-path.js";

const MAX_READ = 8 * 1024 * 1024;
/** Lines are cut before regex tests, so a pathological line cannot stall a pattern. */
const MAX_LINE = 4000;

/** Fatal lines seen in real logs on this PC. */
export const DEFAULT_FAIL_PATTERNS = [/\(F\):/, /Can't compile/, /Unable to start replication/, /Out of memory/, /Application hangs/];

/** Reads the bytes appended to a log since the last call, in whole lines. */
export class LogCursor {
  private pos: number;
  private carry = Buffer.alloc(0);

  constructor(readonly file: string, from: "start" | "end" | number = "start") {
    this.pos = from === "start" ? 0 : from === "end" ? statSync(file).size : from;
  }

  /** Byte offset after the last complete line returned: pass it back as `from` to resume. */
  get cursor(): number {
    return this.pos - this.carry.length;
  }

  /** New complete lines, CR stripped; at most 8 MB per call. */
  read(): string[] {
    const fd = openSync(this.file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < this.cursor) {
        // Shorter than what we read: a new session reused the file name.
        this.pos = 0;
        this.carry = Buffer.alloc(0);
      }
      const len = Math.min(size - this.pos, MAX_READ);
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      this.pos += readSync(fd, buf, 0, len, this.pos);
      const data = Buffer.concat([this.carry, buf]);
      // Split at the last LF byte: never inside a UTF-8 sequence, so no decoder state is needed.
      const lf = data.lastIndexOf(10);
      this.carry = Buffer.from(data.subarray(lf + 1));
      if (lf < 0) return [];
      return data
        .toString("utf8", 0, lf)
        .split("\n")
        .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l).slice(0, MAX_LINE));
    } finally {
      closeSync(fd);
    }
  }

  /** Everything up to the current end of the file. */
  readAll(): string[] {
    const out: string[] = [];
    for (let lines = this.read(); lines.length; lines = this.read()) out.push(...lines);
    return out;
  }
}

/** Line clock: untimed lines (VM exception continuation lines) take the previous line's time. */
function clock(file: string) {
  let header: number | undefined;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024);
    const head = buf.toString("utf8", 0, readSync(fd, buf, 0, 1024, 0));
    for (const l of head.split(/\r?\n/).slice(0, 4)) header ??= parseLogHeader(l);
  } finally {
    closeSync(fd);
  }
  let prev: number | undefined;
  return (line: string): string | undefined => {
    prev = parseLogTime(header, line, prev) ?? prev;
    return prev === undefined ? undefined : formatLogTime(prev, header !== undefined, "T");
  };
}

/** `[TAG] VERB k=v ... rest` anywhere in a line (some harnesses print through a variable dump ending in `'`). */
export function parseHarnessLine(tag: string, line: string): Record<string, string> | null {
  const m = new RegExp(`\\[${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s+(\\w+)\\s*(.*)$`).exec(line);
  if (!m) return null;
  const row: Record<string, string> = { verb: m[1] };
  const rest = m[2].replace(/'$/, "").replace(/(\w+)=(<[^>]*>|\S+)/g, (_, k: string, v: string) => {
    row[k] = v;
    return "";
  });
  row.text = rest.replace(/\s+/g, " ").trim();
  return row;
}

/** True when path lies under one of roots, compared by real path (junctions followed, case-insensitive on Windows). Unreadable paths are refused. */
export function isUnderRoots(path: string, roots: string[]): boolean {
  let target: string;
  try {
    target = realPathOf(path);
  } catch {
    return false;
  }
  return roots.some((r) => {
    try {
      return isContained(realPathOf(r), target);
    } catch {
      return false;
    }
  });
}

export interface LogSpec {
  /** A .log file, a logs_* folder, a logs root, or a profile folder with logs/ below it. */
  dir: string;
  file?: "console" | "script" | "error";
  /** Only a logs_* folder modified at or after this time (epoch ms). */
  newerThan?: number;
}

/** The log file a spec points at now, or null when it does not exist (yet). */
export function resolveLogFile(spec: LogSpec): string | null {
  if (spec.dir.toLowerCase().endsWith(".log")) return existsSync(spec.dir) ? spec.dir : null;
  const name = `${spec.file ?? "console"}.log`;
  if (existsSync(join(spec.dir, name))) return join(spec.dir, name);
  const root = existsSync(join(spec.dir, "logs")) ? join(spec.dir, "logs") : spec.dir;
  const d = newestDir(root, spec.newerThan ?? 0);
  return d && existsSync(join(d, name)) ? join(d, name) : null;
}

export interface Hit {
  name: string;
  /** From `start`: the file line number; from `end` or a cursor: counted from there. */
  lineNo?: number;
  time?: string;
  line: string;
}

export interface WaitResult {
  status: "matched" | "failed" | "timeout" | "exited" | "no-log";
  file: string | null;
  matched: Hit[];
  fatal: Hit[];
  cursor: number;
  elapsedSec: number;
  linesRead: number;
}

export interface WaitOptions {
  /** Re-resolved on every poll until the log exists (a server creates its log folder after start). */
  log: () => string | null;
  patterns: { name: string; regex: RegExp }[];
  match?: "any" | "all";
  failPatterns?: RegExp[];
  from?: "start" | "end" | number;
  pid?: number;
  timeoutMs: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
}

/** Block until a pattern (or all of them) matches, a fail pattern matches, the process exits, or timeout. */
export async function waitFor(o: WaitOptions): Promise<WaitResult> {
  const t0 = Date.now();
  const alive = o.isAlive ?? processAlive;
  const fail = o.failPatterns ?? DEFAULT_FAIL_PATTERNS;
  const matched = new Map<string, Hit>();
  const fatal: Hit[] = [];
  let cur: LogCursor | undefined;
  let file: string | null = null;
  let time: ((l: string) => string | undefined) | undefined;
  let lineNo = 0;
  const done = (status: WaitResult["status"]): WaitResult => ({
    status, file, matched: [...matched.values()], fatal, cursor: cur?.cursor ?? 0, elapsedSec: (Date.now() - t0) / 1000, linesRead: lineNo,
  });

  for (let first = true; ; first = false) {
    if (!cur && (file = o.log())) {
      // A log that appears after the call is read from its start.
      cur = new LogCursor(file, first ? (o.from ?? "end") : "start");
      time = clock(file);
    }
    if (cur) {
      for (let lines = cur.read(); lines.length; lines = cur.read()) {
        for (const line of lines) {
          lineNo++;
          const t = time!(line);
          const f = fail.find((r) => r.test(line));
          if (f) {
            fatal.push({ name: f.source, lineNo, time: t, line });
            return done("failed");
          }
          for (const p of o.patterns) if (!matched.has(p.name) && p.regex.test(line)) matched.set(p.name, { name: p.name, lineNo, time: t, line });
          if (matched.size && (o.match !== "all" || matched.size === o.patterns.length)) return done("matched");
        }
      }
    }
    if (o.pid !== undefined && !alive(o.pid)) return done("exited");
    if (Date.now() - t0 >= o.timeoutMs) return done(cur ? "timeout" : "no-log");
    await sleep(o.pollMs ?? 500);
  }
}

export interface ScanOptions {
  file: string;
  from?: "start" | "end" | number;
  extract?: RegExp[];
  harnessTag?: string;
  assert?: { mustMatch?: RegExp[]; mustNotMatch?: RegExp[]; noScriptErrorsIn?: string[] };
  maxRows?: number;
}

export interface ScanResult {
  file: string;
  rows: Record<string, string>[];
  rowsTotal: number;
  counts: { E: number; W: number; F: number };
  assertions: { assert: string; pass: boolean; firstLine?: Hit }[];
  cursor: number;
  linesRead: number;
}

/** One pass over what the log holds now: extracted rows, severity counts and assertions. */
export function scan(o: ScanOptions): ScanResult {
  const cur = new LogCursor(o.file, o.from ?? "start");
  const time = clock(o.file);
  const maxRows = o.maxRows ?? 200;
  const rows: Record<string, string>[] = [];
  let rowsTotal = 0;
  const counts = { E: 0, W: 0, F: 0 };
  const must = (o.assert?.mustMatch ?? []).map((r) => ({ r, hit: undefined as Hit | undefined }));
  const mustNot = (o.assert?.mustNotMatch ?? []).map((r) => ({ r, hit: undefined as Hit | undefined }));
  const vme = scriptErrorParser({ kinds: ["vme"], frames: 1 });
  const compile: string[] = [];
  let lineNo = 0;
  const addRow = (row: Record<string, string>) => {
    rowsTotal++;
    if (rows.length < maxRows) rows.push(row);
  };

  for (const line of cur.readAll()) {
    lineNo++;
    const t = time(line);
    const hit = (r: RegExp) => ({ name: r.source, lineNo, time: t, line });
    const sev = /\((E|W|F)\)/.exec(line);
    if (sev) counts[sev[1] as "E" | "W" | "F"]++;
    vme.line(line);
    if (/SCRIPT\s+\(E\): @"/.test(line)) compile.push(line);
    for (const x of [...must, ...mustNot]) if (!x.hit && x.r.test(line)) x.hit = hit(x.r);
    for (const r of o.extract ?? []) {
      const m = r.exec(line);
      if (m) addRow({ ...(m.groups ?? {}) });
    }
    const h = o.harnessTag ? parseHarnessLine(o.harnessTag, line) : null;
    if (h) addRow(h);
  }

  const groups = vme.summary().groups;
  const assertions: ScanResult["assertions"] = [
    ...must.map((x) => ({ assert: `mustMatch ${x.r.source}`, pass: !!x.hit, firstLine: x.hit })),
    ...mustNot.map((x) => ({ assert: `mustNotMatch ${x.r.source}`, pass: !x.hit, firstLine: x.hit })),
    ...(o.assert?.noScriptErrorsIn ?? []).map((dir) => {
      const issue = parseScriptIssues(compile.join("\n"), dir).find((i) => i.inAddon);
      // A VM exception belongs to the addon that holds its first stack line.
      const g = groups.find((x) => x.frames[0] && existsSync(join(dir, x.frames[0].file)));
      const firstLine = issue
        ? { name: "compile", line: `${issue.file}:${issue.line}: ${issue.message}` }
        : g
          ? { name: "vme", line: `${g.frames[0].file}:${g.frames[0].line} ${g.frames[0].func}: ${g.reason} (${g.count}x)` }
          : undefined;
      return { assert: `noScriptErrorsIn ${dir}`, pass: !firstLine, firstLine };
    }),
  ];
  return { file: o.file, rows, rowsTotal, counts, assertions, cursor: cur.cursor, linesRead: lineNo };
}
