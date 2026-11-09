import { afterAll, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCrashFolders, sweepLine } from "../../src/watchdog/crash-sweep.js";
import { sweepCrashes } from "../../src/watchdog/wb-watch.js";

// Temp folders only: a fake Workbench logs root, a fake crash folder and a fake watch dir. Nothing reads the real ones.
// Every crash.log Workbench 1.9.0.37 writes starts with this header block (no Reason) before its first entry.
const HEADER = "---------------------------------------------\r\nLog C:\\Users\\user\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_2026-11-01_10-00-00\\crash.log started at 2026-11-01 10:02:00 (2026-11-01 15:02:00 UTC)\r\n\r\n\r\n\r\n";
const LEAK_ENTRY = "------------------------------------\r\n31.10 2026 09:32:55\r\nAssertion failed\r\n\r\nLine: 1287\r\n\r\nReason: Resources are leaking! Check log!\r\n";
const OOW_ENTRY = "------------------------------------\r\n31.10 2026 09:40:01\r\nAssertion failed\r\n\r\nLine: 77\r\n\r\nReason: Entity out of world bounds\r\n";
const LEAK = HEADER + LEAK_ENTRY;
const OUT_OF_WORLD = HEADER + OOW_ENTRY;
const name = (h: number, m = 0, s = 0) => `logs_2026-11-01_${String(h).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
const startMs = (h: number) => new Date(2026, 10, 1, h, 0, 0).getTime();

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true }))); // MCP-0071: the temp folders do not pile up

function setup() {
  const root = mkdtempSync(join(tmpdir(), "emcp-cs-"));
  roots.push(root);
  expect(root.startsWith(tmpdir())).toBe(true); // MCP-0062: assert the temp path before any write
  const logs = join(root, "logs");
  const dest = join(root, "Crash Logs");
  mkdirSync(logs);
  const folder = (n: string, files: Record<string, string | Buffer>) => {
    mkdirSync(join(logs, n), { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(logs, n, f), text);
    return join(logs, n);
  };
  return { root, logs, dest, folder };
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const hashes = (dir: string) => Object.fromEntries(walk(dir).map((p) => [p, createHash("sha256").update(readFileSync(p)).digest("hex")]));
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("saveCrashFolders", () => {
  it("copies a folder with a dump, a hang dump only and a crash.log with a real entry; skips leak-only and empty ones; sources stay byte-identical", () => {
    const t = setup();
    t.folder(name(10), { "crash_1.mdmp": "dump-a", "crash.log": LEAK, "console.log": "c", "error.log": "e", "script.log": "s" });
    t.folder(name(11), { "FREEZE_x.mdmp": "hang", "console.log": "c2" });
    t.folder(name(12), { "crash.log": LEAK, "console.log": "c3" });
    t.folder(name(13), { "crash.log": HEADER + OOW_ENTRY + LEAK_ENTRY, "console.log": "c4" }); // the real entry first: only the last entry would be the leak assert
    t.folder(name(14), { "console.log": "c5" });
    const before = hashes(t.logs);
    const r = saveCrashFolders(t.logs, t.dest);
    expect(r.saved.map((s) => s.folder).sort()).toEqual([name(10), name(11), name(13)]);
    expect(r.errors).toEqual([]);
    expect(listing(t.dest)).toEqual([name(10), name(11), name(13)]);
    expect(listing(join(t.dest, name(10)))).toEqual(["console.log", "crash.log", "crash_1.mdmp", "error.log", "script.log"]);
    expect(listing(join(t.dest, name(11)))).toEqual(["FREEZE_x.mdmp", "console.log"]);
    expect(listing(join(t.dest, name(13)))).toEqual(["console.log", "crash.log"]);
    expect(hashes(t.logs)).toEqual(before);
    expect(sweepLine(r, t.dest)).toBe(`Saved 3 crash folder(s) to ${t.dest}`);
  });

  it("a folder already saved (a <stamp>_<pid> copy holding all its files) is not copied; a second sweep copies nothing", () => {
    const t = setup();
    t.folder(name(10), { "crash.log": HEADER + LEAK_ENTRY + OOW_ENTRY, "console.log": "c" });
    t.folder(name(11), { "a.mdmp": "first", "b.mdmp": "second" });
    t.folder(name(12), { "crash.log": HEADER + LEAK_ENTRY + OOW_ENTRY, "console.log": "c" });
    mkdirSync(join(t.dest, "20261101_100500_4242"), { recursive: true });
    writeFileSync(join(t.dest, "20261101_100500_4242", "crash.log"), HEADER + LEAK_ENTRY + OOW_ENTRY); // the watcher's copy of folder 10 (same bytes)
    writeFileSync(join(t.dest, "20261101_100500_4242", "console.log"), "c");
    mkdirSync(join(t.dest, "20261101_110500_77"), { recursive: true });
    writeFileSync(join(t.dest, "20261101_110500_77", "a.mdmp"), "first");
    writeFileSync(join(t.dest, "20261101_110500_77", "b.mdmp"), "second");
    const first = saveCrashFolders(t.logs, t.dest);
    // folder 12 has the same files as the saved copy of folder 10, so it counts as saved too
    expect(first.saved).toEqual([]);
    t.folder(name(13), { "crash.log": OUT_OF_WORLD });
    const second = saveCrashFolders(t.logs, t.dest);
    expect(second.saved.map((s) => s.folder)).toEqual([name(13)]);
    expect(saveCrashFolders(t.logs, t.dest).saved).toEqual([]);
    expect(listing(t.dest)).toEqual(["20261101_100500_4242", "20261101_110500_77", name(13)]);
  });

  it("a copy folder that misses one of the files (a dump that failed to copy) does not count as saved: the folder is copied again as _2", () => {
    const t = setup();
    t.folder(name(10), { "a.mdmp": "first", "b.mdmp": "second", "console.log": "c" });
    mkdirSync(join(t.dest, name(10)), { recursive: true });
    writeFileSync(join(t.dest, name(10), "a.mdmp"), "first");
    writeFileSync(join(t.dest, name(10), "console.log"), "c"); // b.mdmp is missing
    const r = saveCrashFolders(t.logs, t.dest);
    expect(r.saved.map((s) => s.dest)).toEqual([join(t.dest, `${name(10)}_2`)]);
    expect(listing(join(t.dest, `${name(10)}_2`))).toEqual(["a.mdmp", "b.mdmp", "console.log"]);
    expect(saveCrashFolders(t.logs, t.dest).saved).toEqual([]); // the full copy is recognised now
  });

  it("a name clash gets _2 and then _3, and the folder already there is not touched", () => {
    const t = setup();
    t.folder(name(10), { "crash.log": OUT_OF_WORLD, "console.log": "new" });
    for (const clash of [name(10), `${name(10)}_2`]) {
      mkdirSync(join(t.dest, clash), { recursive: true });
      writeFileSync(join(t.dest, clash, "crash.log"), `other ${clash}`);
    }
    const r = saveCrashFolders(t.logs, t.dest);
    expect(r.saved.map((s) => s.dest)).toEqual([join(t.dest, `${name(10)}_3`)]);
    expect(readFileSync(join(t.dest, `${name(10)}_3`, "console.log"), "utf-8")).toBe("new");
    expect(readFileSync(join(t.dest, name(10), "crash.log"), "utf-8")).toBe(`other ${name(10)}`);
    expect(readFileSync(join(t.dest, `${name(10)}_2`, "crash.log"), "utf-8")).toBe(`other ${name(10)}_2`);
  });

  it("an unreadable file is listed in errors and the sweep goes on", () => {
    const t = setup();
    // A folder in place of a file fails the read the same way a locked file does (MCP-0040).
    mkdirSync(join(t.logs, name(10), "crash.log"), { recursive: true });
    t.folder(name(11), { "a.mdmp": "dump" });
    mkdirSync(join(t.logs, name(11), "console.log")); // fails the copy of one file, not of the folder
    t.folder(name(12), { "b.mdmp": "dump-b", "console.log": "ok" });
    const r = saveCrashFolders(t.logs, t.dest);
    expect(r.saved.map((s) => s.folder).sort()).toEqual([name(11), name(12)]);
    expect(r.errors.some((e) => e.startsWith(`${name(10)}:`))).toBe(true);
    expect(r.errors.some((e) => e.startsWith(`${name(11)}:`) && e.includes("console.log"))).toBe(true);
    expect(listing(join(t.dest, name(12)))).toEqual(["b.mdmp", "console.log"]);
    expect(listing(t.dest)).not.toContain(name(10));
  });

  it("the time cap stops a sweep and says so; the next sweep continues with the folders left", () => {
    const t = setup();
    for (const h of [10, 11, 12]) t.folder(name(h), { "a.mdmp": `dump ${h}` });
    let clock = 0;
    const capped = saveCrashFolders(t.logs, t.dest, { now: () => (clock += 3000), capMs: 5000 });
    expect(capped.capped).toBe(true);
    expect(capped.saved.map((s) => s.folder)).toEqual([name(12), name(11)]); // newest first
    expect(sweepLine(capped, t.dest)).toContain("time cap reached");
    const next = saveCrashFolders(t.logs, t.dest);
    expect(next.capped).toBe(false);
    expect(next.saved.map((s) => s.folder)).toEqual([name(10)]);
    expect(listing(t.dest)).toEqual([name(10), name(11), name(12)]);
  });

  it("nothing is written when there is nothing to save, and a missing logs root is not an error", () => {
    const t = setup();
    t.folder(name(10), { "console.log": "c" });
    expect(saveCrashFolders(t.logs, t.dest).saved).toEqual([]);
    expect(existsSync(t.dest)).toBe(false);
    expect(saveCrashFolders(join(t.root, "no-such-logs"), t.dest)).toEqual({ saved: [], errors: [], capped: false });
    expect(sweepLine({ saved: [], errors: [], capped: false }, t.dest)).toBeUndefined();
  });

  it("ignores a folder that is not named like a Workbench log folder", () => {
    const t = setup();
    t.folder("my_notes", { "a.mdmp": "dump" });
    expect(saveCrashFolders(t.logs, t.dest).saved).toEqual([]);
  });
});

describe("sweepCrashes skips running Workbenches", () => {
  function live() {
    const t = setup();
    const stateDir = join(t.root, "watch");
    mkdirSync(stateDir);
    const own = t.folder(name(10), { "a.mdmp": "dump-own", "crash.log": OUT_OF_WORLD });
    const older = t.folder(name(8), { "b.mdmp": "dump-old" });
    return { ...t, stateDir, own, older };
  }
  const state = (stateDir: string, logDir: string) =>
    writeFileSync(join(stateDir, "4242.json"), JSON.stringify({ pid: 4242, state: "ok", logDir }));

  it("the log folder of a watched Workbench that is alive is not copied; once it is reported dead it is", () => {
    const t = live();
    state(t.stateDir, t.own);
    const noProcs = { pids: () => [] as number[] };
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, { ...noProcs, alive: () => true }).saved.map((s) => s.folder)).toEqual([name(8)]);
    expect(listing(t.dest)).toEqual([name(8)]);
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, { ...noProcs, alive: () => false }).saved.map((s) => s.folder)).toEqual([name(10)]);
    expect(listing(t.dest)).toEqual([name(10), name(8)].sort());
  });

  it("an exited state is not live even when its PID answers", () => {
    const t = live();
    writeFileSync(join(t.stateDir, "4242.json"), JSON.stringify({ pid: 4242, state: "exited", logDir: t.own }));
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, { pids: () => [], alive: () => true }).saved.length).toBe(2);
  });

  it("a folder created after the start of a running Workbench is not copied; with no Workbench running it is", () => {
    const t = live();
    const running = { pids: () => [4242], startOf: () => startMs(10) + 1000 }; // its own log folder is named after that start
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, running).saved.map((s) => s.folder)).toEqual([name(8)]);
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, { pids: () => [] }).saved.map((s) => s.folder)).toEqual([name(10)]);
  });

  it("a running Workbench whose start time cannot be read makes every folder unsafe", () => {
    const t = live();
    expect(sweepCrashes(t.logs, t.dest, t.stateDir, { pids: () => [4242], startOf: () => undefined }).saved).toEqual([]);
    expect(existsSync(t.dest)).toBe(false);
  });
});
