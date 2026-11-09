import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// A fake home first: the instance registry and watch dir land in temp folders, never in the real ~/.enfusion-mcp.
const home = mkdtempSync(join(tmpdir(), "emcp-lw-home-"));
process.env.USERPROFILE = process.env.HOME = home;

// spawn is a stub (no Workbench starts), the watcher spawn is recorded, no Workbench counts as running.
const sys = vi.hoisted(() => ({
  spawnEnv: [] as NodeJS.ProcessEnv[], spawnArgs: [] as string[][], listeners: [] as string[], watcher: [] as string[][], alive: true,
  // what the crash sweep and the spawn did, in order, and what the sweep returns
  order: [] as string[], sweepArgs: [] as unknown[][], saved: [] as { folder: string; dest: string }[], errors: [] as string[],
}));
vi.mock("../../src/watchdog/crash-sweep.js", async (orig) => ({
  ...(await orig<typeof import("../../src/watchdog/crash-sweep.js")>()),
  saveCrashFolders: vi.fn((...a: unknown[]) => {
    sys.order.push("sweep");
    sys.sweepArgs.push(a);
    return { saved: sys.saved, errors: sys.errors, capped: false };
  }),
}));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((_exe: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    sys.order.push("spawn");
    sys.spawnArgs.push(args);
    sys.spawnEnv.push(opts.env ?? {});
    return { pid: 4242, unref: () => {}, on: (ev: string) => sys.listeners.push(ev) };
  }),
}));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  findPids: () => [],
  isAlive: () => sys.alive,
  spawnDetached: vi.fn((_exe: string, args: string[]) => {
    sys.watcher.push(args);
    return 777;
  }),
}));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/game-paths.js")>()),
  findWorkbenchExe: () => join(home, "Tools", "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
}));

const { WorkbenchClient, WorkbenchError } = await import("../../src/workbench/client.js");
const { isOwned, readInstance, pidInstanceFile, WORKBENCH_INSTANCES } = await import("../../src/utils/instances.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");
const { logger } = await import("../../src/utils/logger.js");

const crashRoot = join(home, "Crash Logs");

function client(extra: Partial<Config> = {}) {
  const projects = join(home, "projects");
  mkdirSync(join(projects, "TestAddon"), { recursive: true });
  writeFileSync(join(projects, "TestAddon", "addon.gproj"), 'GameProject {\n ID "TestAddon"\n GUID "1111111111111111"\n}\n');
  const c = new WorkbenchClient("127.0.0.1", 5775, { projectPath: projects, workbenchPath: join(home, "Tools"), crashLogsDir: crashRoot, ...extra } as Config);
  // First call is the "already running?" ping (no), every later one is the NET API wait (answers at once).
  let calls = 0;
  vi.spyOn(c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockImplementation(async () => {
    if (calls++ === 0) throw new Error("refused");
    return {};
  });
  return { c, gproj: join(projects, "TestAddon", "addon.gproj") };
}

beforeEach(() => {
  sys.spawnEnv = [];
  sys.spawnArgs = [];
  sys.listeners = [];
  sys.watcher = [];
  sys.alive = true;
  sys.order = [];
  sys.sweepArgs = [];
  sys.saved = [];
  sys.errors = [];
});

describe("launchWorkbench records and watches what it starts", () => {
  it("writes the instance file, starts an owned watcher for that PID and listens for spawn errors", async () => {
    const { c, gproj } = client();
    const before = Date.now();
    await c.ensureRunning(gproj);
    const inst = readInstance(pidInstanceFile(WORKBENCH_INSTANCES, 4242))!;
    expect(WORKBENCH_INSTANCES.startsWith(home)).toBe(true);
    expect(inst).toMatchObject({ kind: "workbench", pid: 4242, ownerPid: process.pid });
    expect(inst.startedAt).toBeGreaterThanOrEqual(before);
    expect(sys.listeners).toContain("error");
    const args = sys.watcher[0];
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect([flag("--pid"), flag("--start-time"), flag("--port"), flag("--dismiss")]).toEqual(["4242", String(inst.startedAt), "5775", "watched"]);
    expect(args).toContain("--owned");
    expect(flag("--logs-root")).toBe(join(home, "logs"));
    expect(sys.spawnArgs[0]).not.toContain("-noThrow");
    // Owned only while the live process has the recorded start time.
    expect(isOwned(4242, WORKBENCH_INSTANCES, { pid: 4242, ppid: 0, cmd: "", created: inst.startedAt + 500 })).toBe(true);
    expect(isOwned(4242, WORKBENCH_INSTANCES, { pid: 4242, ppid: 0, cmd: "", created: inst.startedAt + 60_000 })).toBe(false);
  });

  it("starts Workbench as the Tools app in Steam and keeps the rest of the environment", async () => {
    const { c, gproj } = client();
    await c.ensureRunning(gproj);
    expect(sys.spawnEnv[0]).toMatchObject({ SteamAppId: "1874910", SteamGameId: "1874910", USERPROFILE: home });
    expect(sys.spawnEnv[0].PATH ?? sys.spawnEnv[0].Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it("adds -noThrow only for an unattended launch", async () => {
    const { c, gproj } = client();
    await c.ensureRunning(gproj, true);
    expect(sys.spawnArgs[0]).toContain("-noThrow");
  });
});

describe("launchWorkbench stops waiting when its Workbench has exited", () => {
  // The "already running?" ping and every NET API poll are refused.
  function refusingClient() {
    const { c, gproj } = client();
    vi.spyOn(c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockRejectedValue(new WorkbenchError("refused", "CONNECTION_REFUSED"));
    c.dialogProbe = async () => []; // the real one starts PowerShell
    return { c, gproj };
  }

  it("fails at once, naming the PID, instead of polling a dead process", async () => {
    const { c, gproj } = refusingClient();
    sys.alive = false;
    const t0 = Date.now();
    await expect(c.ensureRunning(gproj)).rejects.toThrow(/PID 4242\) exited .*CrashReporter/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a start that fails after saving crash folders says so in the error (B-044)", async () => {
    const { c, gproj } = refusingClient();
    sys.alive = false;
    sys.saved = [{ folder: "logs_2026-11-01_10-00-00", dest: join(crashRoot, "logs_2026-11-01_10-00-00") }];
    await expect(c.ensureRunning(gproj)).rejects.toThrow(/exited [\s\S]*Saved 1 crash folder\(s\) to /);
  });

  const modal = { hwnd: 5, cls: "Qt683QWindowIcon", text: "Validating $TestAddon:Worlds/W.ent", visible: true, buttons: ["Yes", "No"], children: [{ hwnd: 0, cls: "Text", text: "The world is obsolete" }] };

  it("names the dialog and stops when the same one is still open at the second check (30 s, then 15 s later)", async () => {
    const { c, gproj } = refusingClient();
    const probe = vi.fn(async () => [{ pid: 4242, dialogs: [modal] }]);
    c.dialogProbe = probe;
    vi.useFakeTimers();
    try {
      const done = expect(c.ensureRunning(gproj, false, "Worlds/W.ent")).rejects.toThrow(/PID 4242\).*showing a dialog[\s\S]*Validating[\s\S]*\[obsolete_world\]/);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(probe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(probe).toHaveBeenCalledTimes(1); // first sighting: keeps polling
      await vi.advanceTimersByTimeAsync(15_000);
      await done;
      expect(probe).toHaveBeenCalledTimes(2);
      expect(probe).toHaveBeenCalledWith([4242]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stop for a dialog that is gone at the next check, or for a leak assert the watchdog answers", async () => {
    const leak = { hwnd: 6, cls: "#32770", text: "Assertion", visible: true, children: [{ hwnd: 7, cls: "Static", text: "Reason: Resources are leaking! Check log!" }, { hwnd: 8, cls: "Button", text: "&Ignore" }] };
    const { c, gproj } = refusingClient();
    let n = 0;
    // progress box with a new window each time, then a leak assert that stays open for every check
    c.dialogProbe = async () => [{ pid: 4242, dialogs: ++n < 3 ? [{ ...modal, hwnd: 100 + n }] : [leak] }];
    vi.useFakeTimers();
    try {
      const done = expect(c.ensureRunning(gproj, false, "Worlds/W.ent")).rejects.toThrow(/did not connect within 300s/);
      await vi.advanceTimersByTimeAsync(305_000);
      await done;
      expect(n).toBeGreaterThan(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks for a dialog at most every 15 s and keeps waiting when there is none", async () => {
    const { c, gproj } = refusingClient();
    const probe = vi.fn(async () => [{ pid: 4242, dialogs: [] }]);
    c.dialogProbe = probe;
    vi.useFakeTimers();
    try {
      const done = expect(c.ensureRunning(gproj)).rejects.toThrow(/did not connect within 90s/);
      await vi.advanceTimersByTimeAsync(95_000);
      await done;
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(probe.mock.calls.length).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling to the timeout while the process is alive", async () => {
    const { c, gproj } = refusingClient();
    vi.useFakeTimers();
    try {
      const done = expect(c.ensureRunning(gproj)).rejects.toThrow(/did not connect within 90s/);
      await vi.advanceTimersByTimeAsync(95_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("launchWorkbench saves crash folders before it starts Workbench (B-044)", () => {
  const two = [{ folder: "logs_a", dest: join(crashRoot, "logs_a") }, { folder: "logs_b", dest: join(crashRoot, "logs_b") }];
  const savedLine = `Saved 2 crash folder(s) to ${crashRoot}`;

  it("sweeps the Workbench logs folder into the crash logs folder right before the spawn", async () => {
    expect(crashRoot.startsWith(home)).toBe(true); // MCP-0062: temp paths only
    sys.saved = two;
    const { c, gproj } = client();
    const note = await c.ensureRunning(gproj);
    expect(sys.order).toEqual(["sweep", "spawn"]);
    expect(sys.sweepArgs[0].slice(0, 2)).toEqual([join(home, "logs"), crashRoot]);
    expect(note).toContain(savedLine);
  });

  it("adds the reply line only when something was saved", async () => {
    const { c, gproj } = client();
    expect(await c.ensureRunning(gproj)).toBeUndefined();
    expect(sys.order).toEqual(["sweep", "spawn"]);
  });

  it("the wb_launch reply carries the line once", async () => {
    sys.saved = two;
    const { c, gproj } = client();
    let calls = 0; // the tool pings once, then launchWorkbench pings again: both refused, then the NET API answers
    vi.spyOn(c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockImplementation(async () => {
      if (calls++ < 2) throw new Error("refused");
      return {};
    });
    const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>> = {};
    registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => { tools[n] = h; } } as unknown as McpServer, {} as Config, c);
    const text = (await tools.wb_launch({ gprojPath: gproj })).content[0].text;
    expect(text.split(savedLine).length - 1).toBe(1);
  });

  it("files the sweep could not save add one line to the start note and to the wb_launch reply, also when nothing was saved", async () => {
    const errLine = "Could not save 2 crash file(s); see the MCP log";
    sys.errors = ["logs_a: a.mdmp unreadable (EBUSY)", "logs_b: not saved after 3 copies: console.log size changed"];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      sys.saved = two;
      const a = client();
      expect(await a.c.ensureRunning(a.gproj)).toBe(`${savedLine}\n${errLine}`);
      sys.saved = [];
      const b = client();
      expect(await b.c.ensureRunning(b.gproj)).toBe(errLine); // nothing new written: no Saved line
      expect(warn).toHaveBeenCalledWith(`Crash folder sweep: ${sys.errors.join("; ")}`);

      const { c, gproj } = client();
      let calls = 0; // the tool pings once, then launchWorkbench pings again: both refused, then the NET API answers
      vi.spyOn(c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockImplementation(async () => {
        if (calls++ < 2) throw new Error("refused");
        return {};
      });
      const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>> = {};
      registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => { tools[n] = h; } } as unknown as McpServer, {} as Config, c);
      const text = (await tools.wb_launch({ gprojPath: gproj })).content[0].text;
      expect(text.split(errLine).length - 1).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a refused launch saves nothing: protected addon without handlers, forbidden root, bad worldPath, a Workbench that already answers", async () => {
    sys.saved = two;
    const prot = client({ protectedAddons: ["2222222222222222"] });
    mkdirSync(join(home, "projects", "Prot"), { recursive: true });
    writeFileSync(join(home, "projects", "Prot", "addon.gproj"), 'GameProject {\n ID "Prot"\n GUID "2222222222222222"\n}\n'); // no handlers inside
    await expect(prot.c.ensureRunning(join(home, "projects", "Prot", "addon.gproj"))).rejects.toThrow(/protected addon/);
    const forbidden = client({ gamePath: join(home, "projects") });
    await expect(forbidden.c.ensureRunning(forbidden.gproj)).rejects.toThrow(/is inside/);
    const bad = client();
    await expect(bad.c.ensureRunning(bad.gproj, false, "World.txt")).rejects.toThrow(/worldPath must be a world/);
    const answering = client();
    vi.spyOn(answering.c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockResolvedValue({});
    expect(await answering.c.ensureRunning(answering.gproj)).toBeUndefined();
    expect(sys.order).toEqual([]);
  });

  it("with no usable crash logs folder nothing is copied and the reply says so once", async () => {
    // The default crash folder sits beside the profile folder; forbid that parent so neither it nor a setting is usable.
    const profile = join(home, "p", "Profile");
    mkdirSync(join(profile, "logs"), { recursive: true });
    process.env.ENFUSION_WORKBENCH_PROFILE = profile;
    process.env.ENFUSION_FORBIDDEN_DIRS = join(home, "p");
    try {
      const { c, gproj } = client({ crashLogsDir: undefined });
      const note = await c.ensureRunning(gproj);
      expect(note?.split("Crash folders were not saved").length).toBe(2);
      expect(note).toContain("no usable crash logs folder (env_check says why). Set ENFUSION_CRASH_LOGS_DIR to a folder of your own.");
      expect(sys.order).toEqual(["spawn"]);
    } finally {
      delete process.env.ENFUSION_WORKBENCH_PROFILE;
      delete process.env.ENFUSION_FORBIDDEN_DIRS;
    }
  });
});
