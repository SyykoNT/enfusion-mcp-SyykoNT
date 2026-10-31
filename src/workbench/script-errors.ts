/**
 * Script runtime errors in Workbench, game and server logs: multi-line `Virtual Machine Exception`
 * blocks and other `SCRIPT (E)` lines, grouped with counts. Compile errors (`@"file,line":`,
 * `Can't compile`) belong to `mod compile` and are not counted here.
 *
 * Block format (1.8 logs; only the first line has a timestamp):
 *   03:59:12.941 SCRIPT    (E): Virtual Machine Exception
 *   Reason: NULL pointer to instance. Variable 'm_bIsListeningToSpec'   (may continue on more lines)
 *   Class:      'EditorMenuUI'                                         (optional)
 *   Function: 'OnMenuUpdate'
 *   Stack trace:
 *   Scripts/Game/Systems/UI/Menus/COA_EditorMenuUI.c:81 Function OnMenuUpdate
 * The stack ends at a blank line (Workbench, client) or straight at the next timestamped line (server).
 */

export interface Frame {
  file: string;
  line: number;
  func: string;
}

export interface ScriptErrorGroup {
  kind: "vme" | "error";
  key: string;
  count: number;
  /** Local time of the first and last entry, epoch ms (1970-01-01 when the log has no header). */
  first: number;
  last: number;
  sessions: string[];
  /** vme: reason (lines joined), class, function, first stack. error: masked message and raw examples. */
  reason?: string;
  className?: string;
  func?: string;
  frames: Frame[];
  message?: string;
  examples: string[];
}

export interface ScriptErrorSummary {
  vme: number;
  errors: number;
  lines: number;
  groups: ScriptErrorGroup[];
}

export interface ParserOptions {
  kinds?: ("vme" | "error")[];
  /** Stack frames kept per group (default 5). */
  frames?: number;
  /** `HH:MM[:SS]`: only entries at or after this local time (the day comes from the log start). */
  since?: string;
  /** Session name recorded on each group (the log folder name). */
  session?: string;
}

const TIME = /^(\d\d):(\d\d):(\d\d)\.(\d{3})/;
const HEADER = /^Log .* started at (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/;
const VME_START = /^\d\d:\d\d:\d\d\.\d{3}\s+SCRIPT\s+\(E\): Virtual Machine Exception$/;
const SCRIPT_ERROR = /^\d\d:\d\d:\d\d\.\d{3}\s+SCRIPT\s+\(E\): (.+)$/;
const FRAME = /^(\S.*\.c):(\d+) Function (\S+)$/;
const HALF_DAY = 12 * 3600_000;

/** Start time of a log from its header line `Log <path> started at YYYY-MM-DD HH:MM:SS`, local epoch ms. */
export function parseLogHeader(line: string): number | undefined {
  const m = HEADER.exec(line);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : undefined;
}

/**
 * Local epoch ms of a line's leading `HH:MM:SS.mmm`, on the day of `prevMs` (else the header, else 1970-01-01).
 * The nearest day wins: runs cross midnight, and lines can be a few ms out of order around it.
 */
export function parseLogTime(header: number | undefined, line: string, prevMs?: number): number | undefined {
  const m = TIME.exec(line);
  if (!m) return undefined;
  const ref = prevMs ?? header;
  const d = new Date(ref ?? new Date(1970, 0, 1).getTime());
  const at = (days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, +m[1], +m[2], +m[3], +m[4]).getTime();
  const t = at(0);
  if (ref === undefined) return t;
  return t < ref - HALF_DAY ? at(1) : t > ref + HALF_DAY ? at(-1) : t;
}

/** Mask the variable parts of a runtime error so repeats group: resource names (paths may hold spaces, so up to the extension) and numbers. */
export const maskMessage = (msg: string) =>
  msg.replace(/\{[0-9A-Fa-f]{16}\}(?:[^'"\n]*?\.[A-Za-z]{1,8}\b)?/g, "<resource>").replace(/\b\d+(\.\d+)?\b/g, "<n>").trim();

interface Block {
  time: number;
  reason: string[];
  className?: string;
  func?: string;
  frames: Frame[];
  inReason: boolean;
  inStack: boolean;
}

/** Line-by-line state machine; feed every line of one log in order, then read `summary()`. */
export function scriptErrorParser(opts: ParserOptions = {}) {
  const kinds = new Set(opts.kinds ?? ["vme", "error"]);
  const maxFrames = opts.frames ?? 5;
  const groups = new Map<string, ScriptErrorGroup>();
  let header: number | undefined;
  let prev: number | undefined;
  let since: number | undefined;
  let cur: Block | undefined;
  let vme = 0;
  let errors = 0;
  let lines = 0;

  const add = (g: Omit<ScriptErrorGroup, "count" | "first" | "last" | "sessions" | "examples">, time: number, example?: string) => {
    let e = groups.get(g.key);
    if (!e) groups.set(g.key, (e = { ...g, count: 0, first: time, last: time, sessions: opts.session ? [opts.session] : [], examples: [] }));
    e.count++;
    e.last = time;
    if (example && e.examples.length < 3 && !e.examples.includes(example)) e.examples.push(example);
  };

  const finish = () => {
    const b = cur!;
    cur = undefined;
    vme++;
    const reason = b.reason.join(" ");
    const func = b.func?.replace(/#\d+$/, "");
    const top = b.frames[0];
    // Client logs spell the same file Scripts/... and scripts/...; #n suffixes differ per instance.
    const key = ["vme", b.reason[0] ?? "", b.className ?? "", func ?? "", top ? `${top.file.toLowerCase()}:${top.line}` : ""].join("|");
    add({ kind: "vme", key, reason, className: b.className, func, frames: b.frames.slice(0, maxFrames) }, b.time);
  };

  return {
    line(raw: string): void {
      lines++;
      const l = raw.trimEnd();
      if (header === undefined && prev === undefined) header = parseLogHeader(l);
      const t = parseLogTime(header, l, prev);
      if (t !== undefined) {
        prev = t;
        if (opts.since && since === undefined) since = parseLogTime(undefined, `${opts.since.length === 5 ? opts.since + ":00" : opts.since}.000`, header ?? t);
      }

      if (cur) {
        if (cur.inStack) {
          const f = FRAME.exec(l);
          if (f) {
            cur.frames.push({ file: f[1], line: Number(f[2]), func: f[3] });
            return;
          }
          finish();
        } else if (t !== undefined) {
          finish(); // cut block: next entry before a stack trace
        } else {
          let m: RegExpExecArray | null;
          if (l.startsWith("Reason:")) {
            cur.reason.push(l.slice(7).trim());
            cur.inReason = true;
          } else if ((m = /^Class:\s+'(.+)'$/.exec(l))) {
            cur.className = m[1];
            cur.inReason = false;
          } else if ((m = /^Function: '(.+)'$/.exec(l))) {
            cur.func = m[1];
            cur.inReason = false;
          } else if (l === "Stack trace:") {
            cur.inStack = true;
          } else if (cur.inReason && l.trim()) {
            cur.reason.push(l.trim()); // reasons span lines, with blank lines between
          }
          return;
        }
      }

      if (t === undefined || (since !== undefined && t < since)) return;
      if (VME_START.test(l)) {
        if (kinds.has("vme")) cur = { time: t, reason: [], frames: [], inReason: false, inStack: false };
        return;
      }
      const m = SCRIPT_ERROR.exec(l);
      if (!m || !kinds.has("error") || m[1].startsWith('@"') || m[1].startsWith("Can't compile")) return;
      errors++;
      const message = maskMessage(m[1]);
      add({ kind: "error", key: `error|${message}`, message, frames: [] }, t, m[1].trim());
    },

    /** Groups by count, highest first. A block cut off at the end of the log is counted as is. */
    summary(): ScriptErrorSummary {
      if (cur) finish();
      return { vme, errors, lines, groups: [...groups.values()].sort((a, b) => b.count - a.count) };
    },
  };
}

/** Stream wrapper over `scriptErrorParser` (e.g. a `readline` interface). */
export async function parseScriptErrors(src: AsyncIterable<string> | Iterable<string>, opts: ParserOptions = {}): Promise<ScriptErrorSummary> {
  const p = scriptErrorParser(opts);
  for await (const l of src) p.line(l);
  return p.summary();
}

/** Join per-session summaries by group key (`sessions > 1`). */
export function mergeSummaries(parts: ScriptErrorSummary[]): ScriptErrorSummary {
  const groups = new Map<string, ScriptErrorGroup>();
  for (const part of parts) {
    for (const g of part.groups) {
      const e = groups.get(g.key);
      if (!e) {
        groups.set(g.key, { ...g, sessions: [...g.sessions], examples: [...g.examples] });
        continue;
      }
      e.count += g.count;
      e.first = Math.min(e.first, g.first);
      e.last = Math.max(e.last, g.last);
      for (const s of g.sessions) if (!e.sessions.includes(s)) e.sessions.push(s);
      for (const x of g.examples) if (e.examples.length < 3 && !e.examples.includes(x)) e.examples.push(x);
    }
  }
  const sum = (k: "vme" | "errors" | "lines") => parts.reduce((n, p) => n + p[k], 0);
  return { vme: sum("vme"), errors: sum("errors"), lines: sum("lines"), groups: [...groups.values()].sort((a, b) => b.count - a.count) };
}
