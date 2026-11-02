import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// A fake home first: the instance registry and watch dir land in temp folders, never in the real ~/.enfusion-mcp.
const home = mkdtempSync(join(tmpdir(), "emcp-lw-home-"));
process.env.USERPROFILE = process.env.HOME = home;

// spawn is a stub (no Workbench starts), the watcher spawn is recorded, no Workbench counts as running.
const sys = vi.hoisted(() => ({ spawnEnv: [] as NodeJS.ProcessEnv[], spawnArgs: [] as string[][], listeners: [] as string[], watcher: [] as string[][], alive: true }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((_exe: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
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

function client() {
  const projects = join(home, "projects");
  mkdirSync(join(projects, "TestAddon"), { recursive: true });
  writeFileSync(join(projects, "TestAddon", "addon.gproj"), 'GameProject {\n ID "TestAddon"\n GUID "1111111111111111"\n}\n');
  const c = new WorkbenchClient("127.0.0.1", 5775, { projectPath: projects, workbenchPath: join(home, "Tools") } as Config);
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
    return { c, gproj };
  }

  it("fails at once, naming the PID, instead of polling a dead process", async () => {
    const { c, gproj } = refusingClient();
    sys.alive = false;
    const t0 = Date.now();
    await expect(c.ensureRunning(gproj)).rejects.toThrow(/PID 4242\) exited .*CrashReporter/);
    expect(Date.now() - t0).toBeLessThan(1000);
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
