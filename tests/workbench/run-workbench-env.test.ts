import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// A fake home first: the sweep reads the watch dir under it, never the real ~/.enfusion-mcp.
const home = mkdtempSync(join(tmpdir(), "emcp-rw-home-"));
process.env.USERPROFILE = process.env.HOME = home;
const roots = [home];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// spawn is a stub that exits at once: no Workbench starts. The crash sweep is a recording stub: nothing is copied.
const sys = vi.hoisted(() => ({
  env: [] as NodeJS.ProcessEnv[], order: [] as string[], sweepArgs: [] as unknown[][], noExe: false,
  saved: [] as { folder: string; dest: string }[], errors: [] as string[],
  // a child that keeps running until killed (B-047 tests); null: the child exits at once
  child: null as null | { kill: () => void; close?: (code: number) => void; spawned: boolean },
  probe: [] as unknown[], probed: 0, killPids: vi.fn(),
}));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((_exe: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    sys.order.push("spawn");
    sys.env.push(opts.env ?? {});
    const c = sys.child;
    if (c) {
      c.spawned = true;
      return { pid: 4242, kill: c.kill, on: (ev: string, cb: (code: number) => void) => { if (ev === "close") c.close = cb; } };
    }
    return { kill: () => {}, on: (ev: string, cb: (code: number) => void) => { if (ev === "close") setTimeout(() => cb(0)); } };
  }),
}));
vi.mock("../../src/utils/process.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/process.js")>()), findPids: () => [], killPids: sys.killPids }));
// The dialog probe is a stub: the real one reads real windows with PowerShell (MCP-0049).
vi.mock("../../src/watchdog/probe.js", async (orig) => ({
  ...(await orig<typeof import("../../src/watchdog/probe.js")>()),
  probeDialogs: vi.fn(async () => { sys.probed++; return sys.probe; }),
}));
vi.mock("../../src/watchdog/crash-sweep.js", async (orig) => ({
  ...(await orig<typeof import("../../src/watchdog/crash-sweep.js")>()),
  saveCrashFolders: vi.fn((...a: unknown[]) => {
    sys.order.push("sweep");
    sys.sweepArgs.push(a);
    return { saved: sys.saved, errors: sys.errors, capped: false };
  }),
}));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/game-paths.js")>()),
  findWorkbenchExe: () => (sys.noExe ? undefined : "C:\\Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe"),
}));

const { compileAddon, packAddon, runWorkbench, DIALOG_CHECK_AFTER_MS, DIALOG_CHECK_EVERY_MS } = await import("../../src/workbench/cli.js");
const { LEAK_TEXT } = await import("../../src/watchdog/signals.js");
const { logger } = await import("../../src/utils/logger.js");

function config(extra: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), "emcp-rw-"));
  roots.push(root);
  mkdirSync(join(root, "logs")); // the profile folder is the parent of the project path only when it holds logs (MCP-0046)
  return { root, config: { projectPath: join(root, "projects"), gamePath: join(root, "game"), workbenchPath: join(root, "tools"), crashLogsDir: join(root, "Crash Logs"), ...extra } as Config };
}

describe("headless Workbench runs", () => {
  it("start as the Tools app in Steam and keep the rest of the environment", async () => {
    const { config: c } = config();
    const run = await runWorkbench(c, ["-wbSilent"], 5000);
    expect(run.exitCode).toBe(0);
    expect(sys.env[0]).toMatchObject({ SteamAppId: "1874910", SteamGameId: "1874910" });
    expect(sys.env[0].PATH ?? sys.env[0].Path).toBe(process.env.PATH ?? process.env.Path);
  });
});

describe("headless runs save crash folders before they start (B-044)", () => {
  it("sweeps the Workbench logs folder into the crash logs folder before the spawn, and carries the line only when something was saved", async () => {
    sys.order = [];
    sys.sweepArgs = [];
    sys.saved = [{ folder: "logs_a", dest: "d" }, { folder: "logs_b", dest: "e" }, { folder: "logs_c", dest: "f" }];
    const { root, config: c } = config();
    const run = await runWorkbench(c, ["-wbSilent"], 5000);
    expect(sys.order).toEqual(["sweep", "spawn"]);
    expect(sys.sweepArgs[0].slice(0, 2)).toEqual([join(root, "logs"), join(root, "Crash Logs")]);
    expect(run.savedCrashes).toBe(`Saved 3 crash folder(s) to ${join(root, "Crash Logs")}`);

    sys.saved = [];
    expect((await runWorkbench(c, ["-wbSilent"], 5000)).savedCrashes).toBeUndefined();
  });

  it("files the sweep could not save add one line to the run, compile and pack results, also when nothing was saved", async () => {
    const errLine = "Could not save 1 crash file(s); see the MCP log";
    sys.errors = ["logs_a: a.mdmp unreadable (EBUSY)"];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { root, config: c } = config();
      expect(root.startsWith(tmpdir())).toBe(true); // MCP-0071: pack makes its out folder; temp only
      sys.saved = [{ folder: "logs_b", dest: "d" }];
      expect((await runWorkbench(c, ["-wbSilent"], 5000)).savedCrashes).toBe(`Saved 1 crash folder(s) to ${join(root, "Crash Logs")}\n${errLine}`);
      sys.saved = [];
      expect((await runWorkbench(c, ["-wbSilent"], 5000)).savedCrashes).toBe(errLine);
      expect((await compileAddon(c, join(root, "projects", "A", "addon.gproj"))).run.savedCrashes).toBe(errLine);
      expect((await packAddon(c, join(root, "projects", "A", "addon.gproj"), join(root, "packed"))).run.savedCrashes).toBe(errLine);
      expect(warn).toHaveBeenCalledWith("Crash folder sweep: logs_a: a.mdmp unreadable (EBUSY)");
    } finally {
      warn.mockRestore();
      sys.errors = [];
      sys.saved = [];
    }
  });

  it("with no usable crash logs folder it copies nothing and the result says so", async () => {
    sys.order = [];
    const { root, config: c } = config({ crashLogsDir: undefined });
    const profile = join(root, "p", "Profile"); // the default crash folder is beside the profile: forbid that parent
    mkdirSync(join(profile, "logs"), { recursive: true });
    process.env.ENFUSION_WORKBENCH_PROFILE = profile;
    process.env.ENFUSION_FORBIDDEN_DIRS = join(root, "p");
    try {
      const run = await runWorkbench(c, ["-wbSilent"], 5000);
      expect(run.savedCrashes).toMatch(/^Crash folders were not saved/);
      expect(run.savedCrashes).toContain("no usable crash logs folder (env_check says why)");
      expect(sys.order).toEqual(["spawn"]);
    } finally {
      delete process.env.ENFUSION_WORKBENCH_PROFILE;
      delete process.env.ENFUSION_FORBIDDEN_DIRS;
    }
  });

  it("a run that cannot start (no Workbench exe) saves nothing", async () => {
    sys.order = [];
    sys.noExe = true;
    try {
      await expect(runWorkbench(config().config, ["-wbSilent"], 5000)).rejects.toThrow(/Workbench not found/);
    } finally {
      sys.noExe = false;
    }
    expect(sys.order).toEqual([]);
  });
});

describe("headless runs that sit on a dialog (B-047)", () => {
  const win = (hwnd: number, text: string, body = "", extra: Record<string, unknown> = {}) =>
    ({ hwnd, cls: "#32770", text, visible: true, children: body ? [{ hwnd: hwnd + 1, cls: "Static", text: body }] : [], ...extra });
  const seen = (...wins: unknown[]) => { sys.probe = [{ pid: 4242, dialogs: wins }]; };
  const stuck = { text: "World data problem", body: "The data is broken" };
  // Returns once the child is spawned; the run itself is in `result` (an object, so the await does not wait for the run).
  const begin = async <T,>(run: () => Promise<T>) => {
    const result = run();
    while (!sys.child?.spawned) await new Promise((r) => setImmediate(r)); // the sweep import resolves on a real tick
    return { result };
  };
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await vi.advanceTimersByTimeAsync(0); };
  const setup = (killCode = 0) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const c = { kill: vi.fn(() => c.close?.(killCode)), close: undefined as ((code: number) => void) | undefined, spawned: false };
    sys.child = c;
    sys.probe = [];
    sys.probed = 0;
    sys.killPids.mockClear();
    return c;
  };
  afterEach(() => { vi.useRealTimers(); sys.child = null; sys.probe = []; });

  it("keeps the check timing wb_launch uses", () => {
    expect([DIALOG_CHECK_AFTER_MS, DIALOG_CHECK_EVERY_MS]).toEqual([30_000, 15_000]);
  });

  it("a dialog open on two checks in a row ends only our own child and the result names it; compile fails", async () => {
    const c = setup(0); // exit code 0 after the kill: the failure must come from the dialog
    seen(win(7, stuck.text, stuck.body));
    const { config: cfg, root } = config();
    const { result } = await begin(() => compileAddon(cfg, join(root, "projects", "A", "addon.gproj"), 600_000));
    await tick(DIALOG_CHECK_AFTER_MS); // first check: seen once
    expect(c.kill).not.toHaveBeenCalled();
    await tick(DIALOG_CHECK_EVERY_MS); // second check: still there
    const r = await result;
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(sys.killPids).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.run.timedOut).toBe(false);
    expect(r.run.seconds).toBe((DIALOG_CHECK_AFTER_MS + DIALOG_CHECK_EVERY_MS) / 1000);
    expect(r.run.dialog).toContain(stuck.text);
    expect(r.run.dialog).toContain(stuck.body);
  });

  it("a dialog seen on one check only does not end the run", async () => {
    const c = setup();
    seen(win(7, "Gone soon"));
    const { result } = await begin(() => runWorkbench(config().config, ["-wbSilent"], 600_000));
    await tick(DIALOG_CHECK_AFTER_MS);
    sys.probe = [{ pid: 4242, dialogs: [] }];
    await tick(DIALOG_CHECK_EVERY_MS * 3);
    expect(sys.probed).toBe(4);
    expect(c.kill).not.toHaveBeenCalled();
    c.close?.(0);
    const r = await result;
    expect(r.dialog).toBeUndefined();
    expect(r.timedOut).toBe(false);
  });

  it("a Script Authorization dialog never ends the run; at the timeout the result names it", async () => {
    const c = setup(1);
    seen(win(7, "Script Authorization Required", "Allow this script?"));
    const { result } = await begin(() => runWorkbench(config().config, ["-wbSilent"], 100_000));
    await tick(DIALOG_CHECK_AFTER_MS + DIALOG_CHECK_EVERY_MS * 3);
    expect(sys.probed).toBe(4);
    expect(c.kill).not.toHaveBeenCalled();
    await tick(100_000);
    const r = await result;
    expect(c.kill).toHaveBeenCalledTimes(1); // the timeout, not the dialog check
    expect(r.timedOut).toBe(true);
    expect(r.dialog).toContain("Script Authorization Required");
  });

  it("a leak assert ends the child, and the run is judged from console.log, not from the exit code", async () => {
    const c = setup(1);
    seen(win(7, "Assert", "", { children: [{ hwnd: 8, cls: "Static", text: LEAK_TEXT }, { hwnd: 9, cls: "Button", text: "&Ignore" }] }));
    const { config: cfg, root } = config();
    const { result } = await begin(() => compileAddon(cfg, join(root, "projects", "A", "addon.gproj"), 600_000));
    await tick(DIALOG_CHECK_AFTER_MS + DIALOG_CHECK_EVERY_MS);
    const r = await result;
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(r.run.leakAssertEnded).toBe(true);
    expect(r.run.dialog).toBeUndefined();
    expect(r.run.exitCode).toBe(1);
    expect(r.ok).toBe(true);
  });
});
