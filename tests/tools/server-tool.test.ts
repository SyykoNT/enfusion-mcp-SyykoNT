import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { crashLogsDir } from "../../src/workbench/cli.js";
import { MCP_HOME, SERVER_DOWNLOAD_DIR, type Config } from "../../src/config.js";
import { registerServer, unpack } from "../../src/tools/server.js";
import { isAlive, killPids, limitProcess, serverProcesses, sleep, spawnDetached } from "../../src/utils/process.js";
import { INSTANCE_FILE, OWNER } from "../../src/utils/instances.js";
import { PROC_WATCH_DIR } from "../../src/watchdog/proc-watch.js";
import { MISSION_ROOT, SETTLE_MS } from "../../src/tools/mission-server.js";

// A fake home before any module loads: the watcher state folder, the downloads and the instance registry are temp folders.
const home = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "emcp-srv-home-"));
  process.env.USERPROFILE = process.env.HOME = h;
  return h;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

// The real startProcWatcher runs, but its spawn is recorded here and the platform is set per test: no watcher process starts.
const watch = vi.hoisted(() => ({ spawns: [] as { args: string[]; instanceThere: boolean }[], platform: "win32" }));
vi.mock("../../src/watchdog/proc-watch.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/watchdog/proc-watch.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    startProcWatcher: (w: Parameters<typeof actual.startProcWatcher>[0], spawn?: Parameters<typeof actual.startProcWatcher>[1], platform?: string) =>
      actual.startProcWatcher(w, spawn ?? ((_exe, args) => (watch.spawns.push({ args, instanceThere: fs.existsSync(w.instance) }), 7777)), platform ?? watch.platform),
  };
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

// The downloads folder moves to a temp path that does not exist yet, so start creating it is visible and the real home stays untouched.
vi.mock("../../src/config.js", async (importActual) => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { ...(await importActual<typeof import("../../src/config.js")>()), SERVER_DOWNLOAD_DIR: join(tmpdir(), `emcp-srv-dl-${process.pid}-${Date.now()}`) };
});

// A 16-core Windows PC (watch.platform, per test), so the cpuMask checks do not depend on the machine running the suite.
vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  const stubs = { availableParallelism: () => 16, platform: () => watch.platform };
  return { ...actual, ...stubs, default: { ...actual, ...stubs } };
});

// No real process is started or queried: start "spawns" a fake PID that is already gone.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  spawnDetached: vi.fn(() => 424242),
  serverProcesses: vi.fn(() => []),
  findPids: vi.fn(() => []),
  isAlive: vi.fn(() => false),
  sleep: vi.fn(async () => {}),
  limitProcess: vi.fn(() => true),
  killPids: vi.fn(),
}));

const root = mkdtempSync(join(tmpdir(), "emcp-srv-"));
const config = {
  projectPath: join(root, "projects"),
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  serverPath: join(root, "server"),
  steamcmdPath: join(root, "steamcmd"),
  serverProfilePath: join(root, "profile"),
  packedPath: join(root, "packed"),
} as Config;
mkdirSync(config.gamePath, { recursive: true });

// Lines 337-347 of a real ConflictGen19 server console.log, then a second block in the server form (no blank lines, the stack ends at the next timestamped line).
const VME_LOG = [
  "Log C:/x/logs_2026-11-09_12-14-01/console.log started at 2026-11-09 12:14:01 (2026-11-09 17:14:01 UTC)",
  "12:14:03.000 DEFAULT      : Entered online game state.",
  "12:14:18.032 SCRIPT    (E): Virtual Machine Exception",
  "",
  "Reason: NULL pointer to instance",
  "",
  "Class:      'SCR_CampaignMilitaryBaseComponent'",
  "Function: 'OnAllBasesInitialized'",
  "Stack trace:",
  "Scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized",
  "Scripts/Game/Campaign/SCR_CampaignMilitaryBaseManager.c:274 Function OnAllBasesInitialized",
  "Scripts/Game/GameMode/SCR_GameModeCampaign.c:610 Function Start",
  "Scripts/Game/GameMode/SCR_GameModeCampaign.c:946 Function OnGameStart",
  "12:14:19.000 ENGINE       : after the first block",
  "12:14:40.500 SCRIPT    (E): Virtual Machine Exception",
  "Reason: Division by zero",
  "Class:      'SCR_Other'",
  "Function: 'Tick'",
  "Stack trace:",
  "Scripts/Game/SCR_Other.c:12 Function Tick",
  "12:14:41.000 ENGINE       : after the second block",
].join("\r\n");
const CRASH_LOG = Array.from({ length: 60 }, (_, i) => (i === 4 ? "Reason: Access violation" : `crash-line-${i + 1}`)).join("\n");
const expectReport = (t: string) => {
  expect(t).toContain("**Script exceptions in this run: 2**");
  expect(t).toContain("Reason: NULL pointer to instance\nClass: SCR_CampaignMilitaryBaseComponent\nFunction: OnAllBasesInitialized\nScripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized");
  expect(t).toMatch(/\*\*crash\.log\*\* [^\n]*crash\.log\n```\n(?:[^\n]*\n)*Reason: Access violation\n/);
  expect(t).toContain("crash-line-40\n");
  expect(t).not.toContain("crash-line-41");
};
const expectClean = (t: string) => {
  expect(t).not.toContain("Script exceptions in this run");
  expect(t).not.toContain("**crash.log**");
};
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let tool!: Handler;
registerServer({ registerTool: (_n: string, _d: unknown, h: Handler) => { tool = h; } } as unknown as McpServer, config);

describe("server config", () => {
  it("writes the MCP's own server.json, also over an earlier one", async () => {
    expect((await tool({ action: "config", name: "A" })).isError).toBeFalsy();
    expect((await tool({ action: "config", name: "B" })).isError).toBeFalsy();
    expect(JSON.parse(readFileSync(join(config.serverProfilePath, "server.json"), "utf-8")).game.name).toBe("B");
  });

  it("writes a new file at configPath", async () => {
    const p = join(root, "new", "server.json");
    expect((await tool({ action: "config", configPath: p })).isError).toBeFalsy();
    expect(existsSync(p)).toBe(true);
  });

  it("never overwrites another existing server.json (config or start)", async () => {
    const p = join(root, "mine.json");
    writeFileSync(p, "{\"mine\":true}");
    for (const action of ["config", "start"]) {
      const r = await tool({ action, configPath: p, scenarioId: "{ECC61978EDCC2B5A}Missions/23_Campaign.conf" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/not written.*already exists/);
    }
    expect(readFileSync(p, "utf-8")).toBe("{\"mine\":true}");
  });

  it("refuses a new file inside a protected addon", async () => {
    const crf = join(root, "projects", "Coalition-Reforger-Framework");
    mkdirSync(crf, { recursive: true });
    writeFileSync(join(crf, "addon.gproj"), 'GameProject {\n ID "CRF"\n GUID "5EB3564A02CE294F"\n}\n');
    const p = join(crf, "Configs", "server.json");
    let h!: Handler;
    registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, { ...config, protectedAddons: ["5EB3564A02CE294F"] } as Config);
    const r = await h({ action: "config", configPath: p });
    expect(r.content[0].text).toMatch(/not written.*protected addon/);
    expect(existsSync(p)).toBe(false);
  });

  it("refuses a new file inside the game install", async () => {
    const p = join(config.gamePath, "server.json");
    const r = await tool({ action: "config", configPath: p });
    expect(r.content[0].text).toMatch(/not written.*is inside/);
    expect(existsSync(p)).toBe(false);
  });
});

describe("server install/update", () => {
  it("refuses a server path inside Steam's own steamapps/common", async () => {
    const steam = { ...config, serverPath: join(root, "steamapps", "common", "Arma Reforger Server"), steamcmdPath: join(root, "steamcmd-x") } as Config;
    let h!: Handler;
    registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, steam);
    for (const action of ["install", "update"]) {
      const r = await h({ action });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(`set ENFUSION_SERVER_PATH to a folder of its own for SteamCMD, for example ${join(MCP_HOME, "server")}`);
    }
    expect(existsSync(steam.steamcmdPath)).toBe(false);
  });
});

describe("unpack", () => {
  // The zip path is Windows only (SteamCMD for Linux ships as .tar.gz).
  it.runIf(process.platform === "win32")("extracts a zip into a path with an apostrophe", () => {
    const src = join(root, "zipsrc");
    mkdirSync(src);
    writeFileSync(join(src, "steamcmd.exe"), "x");
    const archive = join(root, "steamcmd.zip");
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", archive, "-C", src, "steamcmd.exe"]);
    const dest = join(root, "O'Neil", "steamcmd");
    mkdirSync(dest, { recursive: true });
    unpack(archive, dest);
    expect(readFileSync(join(dest, "steamcmd.exe"), "utf-8")).toBe("x");
  });
});

describe("server start ports", () => {
  const cfg = { ...config, serverPath: join(root, "srv2"), serverProfilePath: join(root, "prof2"), packedPath: join(root, "packed2") } as Config;
  mkdirSync(cfg.serverPath, { recursive: true });
  writeFileSync(join(cfg.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer"), "");
  mkdirSync(join(cfg.packedPath, "TestAddon"), { recursive: true });
  writeFileSync(join(cfg.packedPath, "TestAddon", "data.pak"), "");
  writeFileSync(join(cfg.packedPath, "TestAddon", "addon.gproj"), "GameProject {\n ID \"TestAddon\"\n GUID \"1111111111111111\"\n}\n");
  let h!: Handler;
  registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);

  it("-server mode binds 127.0.0.1 with -addr and prints that port", async () => {
    const t = (await h({ action: "start", addons: ["TestAddon"], scenarioId: "{ECC61978EDCC2B5A}Missions/23_Campaign.conf", port: 2302 })).content[0].text;
    expect(t).toContain("-addr 127.0.0.1:2302");
    expect(t).toContain("-disableCrashReporter");
    expect(t).not.toContain("-bindPort");
    expect(t).toContain("connect=127.0.0.1:2302");
  });

  it("-config mode prints server.json's bindPort", async () => {
    mkdirSync(cfg.serverProfilePath, { recursive: true });
    writeFileSync(join(cfg.serverProfilePath, "server.json"), JSON.stringify({ bindPort: 2402, game: {} }));
    const t = (await h({ action: "start" })).content[0].text;
    expect(t).toContain("connect=127.0.0.1:2402");
  });

  it("refuses the flags the tool sets, and the Workshop repair switches, in extraArgs; nothing is spawned (B-046)", async () => {
    vi.mocked(spawnDetached).mockClear();
    const forms = ["-config", "-server", "-addonsDir", "-addons", "-addr", "-addonsRepair", "-addonsVerify",
      "-CONFIG", "--Server", "/addonsdir", "-ADDONS=x", "-addr:127.0.0.1:1", "-ADDONSREPAIR", "–addonsVerify", "​-addonsRepair"];
    for (const form of forms) {
      const r = await h({ action: "start", extraArgs: [form, "x"] });
      expect(r.isError, form).toBe(true);
      expect(r.content[0].text, form).toContain("extraArgs may not contain");
      expect(r.content[0].text, form).toMatch(/-config or -server, -addr, -addonsDir, -addons and -addonDownloadDir/);
    }
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("-config mode and -server mode both pass -addonDownloadDir with the downloads folder, and create it (B-046)", async () => {
    mkdirSync(cfg.serverProfilePath, { recursive: true });
    writeFileSync(join(cfg.serverProfilePath, "server.json"), JSON.stringify({ bindPort: 2402, game: {} }));
    const starts: Record<string, unknown>[] = [{ action: "start" }, { action: "start", addons: ["TestAddon"], scenarioId: "{ECC61978EDCC2B5A}Missions/23_Campaign.conf" }];
    for (const start of starts) {
      rmSync(SERVER_DOWNLOAD_DIR, { recursive: true, force: true });
      vi.mocked(spawnDetached).mockClear();
      await h(start); // the stub server "exits early", so the reply is an error either way
      const argv = vi.mocked(spawnDetached).mock.calls[0][1];
      expect(argv[argv.indexOf("-addonDownloadDir") + 1]).toBe(SERVER_DOWNLOAD_DIR);
      expect(argv).toContain(start.addons ? "-server" : "-config");
      expect(existsSync(SERVER_DOWNLOAD_DIR)).toBe(true);
    }
  });

  it("the description sends Mission Header runs to mission_server; extraArgs names the refusals (B-046)", () => {
    let def!: { description: string; inputSchema: { extraArgs: { description?: string } } };
    registerServer({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, cfg);
    expect(def.description).toContain("For a mission on unpacked addons that needs its Mission Header, use mission_server; `server` runs packed builds or a server.json.");
    expect(def.inputSchema.extraArgs.description).toMatch(/Refused: -config, -server, -addr, -addonsDir, -addons .*-addonsRepair, -addonsVerify/);
  });
});

describe("server start and status: -noThrow once, and the script error report", () => {
  const cfg = { ...config, serverPath: join(root, "srv3"), serverProfilePath: join(root, "prof3"), packedPath: join(root, "packed3") } as Config;
  mkdirSync(cfg.serverPath, { recursive: true });
  writeFileSync(join(cfg.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer"), "");
  mkdirSync(join(cfg.packedPath, "TestAddon"), { recursive: true });
  writeFileSync(join(cfg.packedPath, "TestAddon", "data.pak"), "");
  writeFileSync(join(cfg.packedPath, "TestAddon", "addon.gproj"), "GameProject {\n ID \"TestAddon\"\n GUID \"1111111111111111\"\n}\n");
  let h!: Handler;
  registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);
  const SCENARIO = "{ECC61978EDCC2B5A}Missions/23_Campaign.conf";

  /** The run's log folder holds the fixture (with a crash.log) or a clean log. */
  const putLogs = (vme: boolean) => {
    const dir = join(cfg.serverProfilePath, "logs", "logs_2026-11-09_12-14-01");
    rmSync(join(cfg.serverProfilePath, "logs"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "console.log"), vme ? VME_LOG : "12:00:00.000 DEFAULT      : Entered online game state.\r\n");
    if (vme) writeFileSync(join(dir, "crash.log"), CRASH_LOG);
  };

  it("passes -noThrow once in -config mode and in -server mode", async () => {
    for (const start of [{ action: "start" }, { action: "start", addons: ["TestAddon"], scenarioId: SCENARIO }]) {
      vi.mocked(spawnDetached).mockClear();
      await h(start);
      expect(vi.mocked(spawnDetached).mock.calls[0][1].filter((x) => x === "-noThrow")).toHaveLength(1);
    }
  });

  it("start and status print the report for the fixture, and nothing new for a clean log", async () => {
    putLogs(true);
    expectReport((await h({ action: "start" })).content[0].text);
    expectReport((await h({ action: "status" })).content[0].text);
    putLogs(false);
    expectClean((await h({ action: "start" })).content[0].text);
    expectClean((await h({ action: "status" })).content[0].text);
  });

  it("a closing fence inside the console tail cannot close the reply's code block, in start and in logs", async () => {
    const dir = join(cfg.serverProfilePath, "logs", "logs_2026-11-09_13-00-00");
    rmSync(join(cfg.serverProfilePath, "logs"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "console.log"), "13:00:00.000 DEFAULT      : first\r\n13:00:01.000 DEFAULT      : ``` **not bold** [link](x)\r\n");
    for (const reply of [await h({ action: "start" }), await h({ action: "logs", lines: 5 })]) {
      const t = reply.content[0].text;
      expect(t).toContain("''' **not bold** [link](x)");
      expect(t.match(/```/g)).toHaveLength(2);
    }
  });

  it("a closing fence inside the install log tail cannot close the status reply's code block (B-165)", async () => {
    const log = join(cfg.steamcmdPath, "install-server.log");
    mkdirSync(cfg.steamcmdPath, { recursive: true });
    writeFileSync(log, "Update state\r\n``` **not bold** [link](x)\r\nSuccess\r\n");
    try {
      const t = (await h({ action: "status" })).content[0].text;
      expect(t).toContain("Install log (last lines):\n```\nUpdate state\n''' **not bold** [link](x)\nSuccess\n");
      expect(t.match(/```/g)).toHaveLength(2);
    } finally {
      rmSync(log, { force: true });
    }
  });

  it("the description says every server runs with -noThrow and the replies report script exceptions", () => {
    let def!: { description: string };
    registerServer({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, cfg);
    expect(def.description).toMatch(/runs with -noThrow.*report the run's script exceptions/);
  });
});

/** A watcher state file as the watcher writes it, into the watch folder the tools read. */
let stateSeq = 0;
function putState(instance: string, over: Record<string, unknown> = {}) {
  const s = {
    pid: 31820, kind: "server", instance, ownerPid: 99999, watcherPid: 4242, state: "ended_vme", since: Date.now(), samples: 3, updated: Date.now(),
    dialog: { title: "Virtual machine exception", text: "NULL pointer to instance" }, saved: "C:\\crash\\server_x", ...over,
  };
  mkdirSync(PROC_WATCH_DIR, { recursive: true });
  writeFileSync(join(PROC_WATCH_DIR, `${s.pid}_${stateSeq++}.json`), JSON.stringify(s));
}
const HOUR = 3600_000;

describe("server start: waits for the online line, then settles (B-156)", () => {
  const cfg = { ...config, serverPath: join(root, "srv-on"), serverProfilePath: join(root, "prof-on"), packedPath: join(root, "packed-on") } as Config;
  mkdirSync(cfg.serverPath, { recursive: true });
  writeFileSync(join(cfg.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer"), "");
  let h!: Handler;
  registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);
  const logDir = join(cfg.serverProfilePath, "logs", "logs_2026-11-09_12-14-01");
  const putLog = (text: string) => {
    rmSync(join(cfg.serverProfilePath, "logs"), { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "console.log"), text);
  };
  const sleeps: number[] = [];
  let onSleep: ((ms: number) => void) | undefined;
  beforeEach(() => {
    sleeps.length = 0;
    onSleep = undefined;
    vi.mocked(sleep).mockImplementation(async (ms: number) => { sleeps.push(ms); onSleep?.(ms); });
  });
  afterEach(() => {
    vi.mocked(sleep).mockImplementation(async () => {});
    vi.mocked(isAlive).mockImplementation(() => false);
    rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
  });

  it("the settle after the online line catches a VME and crash.log written only then", async () => {
    vi.mocked(isAlive).mockImplementation(() => true);
    const at = VME_LOG.indexOf("12:14:18.032");
    putLog(VME_LOG.slice(0, at));
    onSleep = (ms) => {
      if (ms !== SETTLE_MS) return;
      appendFileSync(join(logDir, "console.log"), VME_LOG.slice(at));
      writeFileSync(join(logDir, "crash.log"), CRASH_LOG);
    };
    const r = await h({ action: "start" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("**Server online after ");
    expectReport(r.content[0].text);
    expect(sleeps.filter((ms) => ms === SETTLE_MS)).toHaveLength(1);
  });

  it("a server that exited before the online line, or right after it, gets no settle and an error reply", async () => {
    for (const log of ["00:00:01.000 ENGINE       : loading\r\n", "00:00:01.000 DEFAULT      : Entered online game state.\r\n"]) {
      sleeps.length = 0;
      putLog(log);
      const r = await h({ action: "start" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("**Server exited early**");
      expect(sleeps).toEqual([]); // no settle, and no fixed wait either
    }
  });

  it("a server still running without the online line after 120 s gets no settle and a non-error reply naming server status", async () => {
    vi.mocked(isAlive).mockImplementation(() => true);
    putLog("00:00:01.000 ENGINE       : loading\r\n");
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    onSleep = (ms) => { clock += ms; };
    try {
      const r = await h({ action: "start" });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("**Server running, not online after 120 s (`server status` shows more)**");
      expect(sleeps).not.toContain(SETTLE_MS);
    } finally {
      now.mockRestore();
    }
  });
});

describe("server start: the process watcher", () => {
  const mk = (name: string, exe = true) => {
    const cfg = { ...config, serverPath: join(root, `${name}-srv`), serverProfilePath: join(root, `${name}-prof`), packedPath: join(root, `${name}-packed`) } as Config;
    mkdirSync(cfg.serverPath, { recursive: true });
    if (exe) writeFileSync(join(cfg.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer"), "");
    mkdirSync(join(cfg.packedPath, "TestAddon"), { recursive: true });
    writeFileSync(join(cfg.packedPath, "TestAddon", "data.pak"), "");
    writeFileSync(join(cfg.packedPath, "TestAddon", "addon.gproj"), "GameProject {\n ID \"TestAddon\"\n GUID \"1111111111111111\"\n}\n");
    let h!: Handler;
    registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);
    return { cfg, h };
  };
  const SCENARIO = "{ECC61978EDCC2B5A}Missions/23_Campaign.conf";
  beforeEach(() => {
    watch.spawns.length = 0;
    watch.platform = "win32";
    vi.mocked(spawnDetached).mockClear();
  });
  afterEach(() => {
    vi.mocked(isAlive).mockImplementation(() => false);
    rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
  });

  it("starts one watcher in -config mode and in -server mode: the PID, its instance file (already written), this MCP, the logs root and the kind", async () => {
    const { cfg, h } = mk("w1");
    for (const start of [{ action: "start" }, { action: "start", addons: ["TestAddon"], scenarioId: SCENARIO }]) {
      watch.spawns.length = 0;
      await h(start);
      expect(watch.spawns).toHaveLength(1);
      const { args, instanceThere } = watch.spawns[0];
      expect(instanceThere).toBe(true);
      expect(args.slice(args.indexOf("--pid"))).toEqual(expect.arrayContaining([
        "--pid", "424242", "--kind", "server", "--instance", join(cfg.serverProfilePath, INSTANCE_FILE),
        "--owner-pid", String(OWNER.pid), "--owner-started", String(OWNER.startedAt), "--logs-root", join(cfg.serverProfilePath, "logs"),
      ]));
      expect(flag(args, "--state-dir")).toBe(PROC_WATCH_DIR);
      expect(args.includes("--crash-dir") ? flag(args, "--crash-dir") : undefined).toBe(crashLogsDir(cfg));
    }
  });

  it("starts none for a start that is refused or fails before the instance file is written", async () => {
    const a = mk("w2");
    const refused: [string, Record<string, unknown>, Handler?][] = [
      ["extraArgs", { action: "start", extraArgs: ["-config", "x"] }],
      ["no packed build", { action: "start", addons: ["Missing"], scenarioId: SCENARIO }],
      ["no exe", { action: "start" }, mk("w2b", false).h],
    ];
    for (const [why, args, handler] of refused) {
      const r = await (handler ?? a.h)(args);
      expect(r.isError, why).toBe(true);
    }
    // A server already running in the profile folder.
    vi.mocked(serverProcesses).mockReturnValueOnce([{ pid: 55, ppid: 1, cmd: `ArmaReforgerServer.exe -profile "${a.cfg.serverProfilePath}"`, created: Date.now() }]);
    const busy = await a.h({ action: "start" });
    expect(busy.content[0].text).toContain("already running");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(watch.spawns).toEqual([]);
  });

  it("starts none when the instance file cannot be written, although the server was spawned", async () => {
    const { cfg, h } = mk("w3");
    mkdirSync(join(cfg.serverProfilePath, INSTANCE_FILE), { recursive: true }); // a folder where the file goes
    const r = await h({ action: "start" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("server start failed");
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(watch.spawns).toEqual([]);
  });

  it("on a platform other than Windows starts no watcher and the start reply is the same", async () => {
    const { h } = mk("w4");
    const onWindows = (await h({ action: "start" })).content[0].text;
    expect(watch.spawns).toHaveLength(1);
    watch.spawns.length = 0;
    watch.platform = "linux";
    const elsewhere = (await h({ action: "start" })).content[0].text;
    expect(watch.spawns).toEqual([]);
    expect(elsewhere).toBe(onWindows);
  });

  it("a watcher that cannot start does not fail the start", async () => {
    const { cfg, h } = mk("w5");
    rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
    mkdirSync(join(PROC_WATCH_DIR, ".."), { recursive: true });
    writeFileSync(PROC_WATCH_DIR, "a file where the state folder goes");
    const r = await h({ action: "start" });
    rmSync(PROC_WATCH_DIR);
    expect(r.content[0].text).toContain("(pid 424242)");
    expect(existsSync(join(cfg.serverProfilePath, INSTANCE_FILE))).toBe(true);
    // B-176: the reply says why, in one line, as mission_server does.
    expect(r.content[0].text.match(/^No process watcher: .+$/gm)).toHaveLength(1);
    expect(r.content[0].text).toMatch(/\nNo process watcher: [^\n]*mkdir/);
  });

  it("a start whose watcher starts has no watcher line (B-176)", async () => {
    const { h } = mk("w6");
    const r = await h({ action: "start" });
    expect(watch.spawns).toHaveLength(1);
    expect(r.content[0].text).not.toContain("No process watcher");
  });
});

describe("server status: the process watcher states", () => {
  afterEach(() => {
    vi.mocked(isAlive).mockImplementation(() => false);
    rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
  });

  it("shows the last 24 h of blocked_dialog, ending_vme, ended_vme and end_failed states under the server profile, and nothing else", async () => {
    const cfg = { ...config, serverProfilePath: join(root, "w6-prof") } as Config;
    let h!: Handler;
    registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);
    vi.mocked(isAlive).mockImplementation((pid) => pid === 4242);
    const mine = join(cfg.serverProfilePath, INSTANCE_FILE);
    const now = Date.now();
    // Shown: live blocked and ending states, final states with a dead watcher, one written by an earlier MCP process (another owner), one 23 h old.
    putState(mine, { pid: 1001, state: "blocked_dialog", dialog: { title: "Script Authorization Required", text: "x" }, why: "not ended: it was not started by this MCP session", saved: undefined });
    putState(mine, { pid: 1002, state: "ending_vme" });
    putState(mine, { pid: 1003, watcherPid: 4343, ownerPid: 12345 });
    putState(mine, { pid: 1004, watcherPid: 4343, state: "end_failed", saved: undefined });
    putState(mine, { pid: 1005, watcherPid: 4343, updated: now - 23 * HOUR });
    // Not shown: 25 h old; another tool's root (a mission_server run, a client folder, a sibling folder with the same name start); a non-final state whose watcher is dead; the watching and exited states; damaged fields.
    putState(mine, { pid: 2001, watcherPid: 4343, updated: now - 25 * HOUR });
    putState(join(MISSION_ROOT, "2521", "server", INSTANCE_FILE), { pid: 2002 });
    putState(join(root, "w6-client", `2003.${INSTANCE_FILE}`), { pid: 2003, kind: "client" });
    putState(join(`${cfg.serverProfilePath}-other`, INSTANCE_FILE), { pid: 2004 });
    putState(mine, { pid: 2005, watcherPid: 4343, state: "blocked_dialog" });
    putState(mine, { pid: 2006, watcherPid: 4343, state: "ending_vme" });
    putState(mine, { pid: 2007, state: "watching" });
    putState(mine, { pid: 2008, state: "exited" });
    putState(mine, { pid: 2009, updated: "yesterday" });
    putState(mine, { pid: 2010, watcherPid: "x" });
    const t = (await h({ action: "status" })).content[0].text;
    for (const pid of [1001, 1002, 1003, 1004, 1005]) expect(t, String(pid)).toContain(`server PID ${pid},`);
    for (const pid of [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010]) expect(t, String(pid)).not.toContain(`PID ${pid},`);
    expect(t).toContain('blocked by a dialog "Script Authorization Required", not ended: it was not started by this MCP session');
    expect(t).toContain('ended after a VM exception window "Virtual machine exception" stayed open; logs saved to C:\\crash\\server_x');
    expect(t).toContain("could not be ended after a VM exception window stayed open");
  });

  it("the description says a VM exception window on a server it started ends that server and its logs are saved", () => {
    let def!: { description: string };
    registerServer({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, config);
    expect(def.description).toMatch(/VM exception window stays open on it, that process \(and only that one\) is ended and its logs are saved/);
  });
});

describe("server start: cpuMask", () => {
  const cfg = { ...config, serverPath: join(root, "cpu-srv"), serverProfilePath: join(root, "cpu-prof"), packedPath: join(root, "cpu-packed") } as Config;
  mkdirSync(cfg.serverPath, { recursive: true });
  writeFileSync(join(cfg.serverPath, process.platform === "win32" ? "ArmaReforgerServer.exe" : "ArmaReforgerServer"), "");
  let h!: Handler;
  registerServer({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, cfg);
  const instanceFile = join(cfg.serverProfilePath, INSTANCE_FILE);
  beforeEach(() => {
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(limitProcess).mockClear();
    vi.mocked(limitProcess).mockImplementation(() => true);
    vi.mocked(killPids).mockClear();
    watch.platform = "win32";
    rmSync(cfg.serverProfilePath, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.mocked(isAlive).mockImplementation(() => false);
    rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
  });

  it("applies the mask and BelowNormal to the server PID and says so", async () => {
    const r = await h({ action: "start", cpuMask: "0x3000" });
    expect(limitProcess).toHaveBeenCalledTimes(1);
    expect(limitProcess).toHaveBeenCalledWith(424242, 0x3000);
    expect(r.content[0].text).toContain("CPU: cpuMask 0x3000 applied, BelowNormal");
    expect(killPids).not.toHaveBeenCalled();
  });

  it.each([
    ["not hex", "nonsense", /^cpuMask must be given as a hex mask, for example 0x3000$/],
    ["zero", "0x0", /^cpuMask must be given as a hex mask/],
    ["empty", "", /^cpuMask must be given as a hex mask/],
    ["a core this PC lacks", "0x30000", /^cpuMask 0x30000 names core 17, but this PC has 16 logical cores \(0 to 15\)$/],
    ["the first core past the last one", "0x10000", /^cpuMask 0x10000 names core 16, but this PC has 16 logical cores \(0 to 15\)$/],
  ])("refuses %s before anything is written or spawned", async (_why, cpuMask, msg) => {
    const r = await h({ action: "start", cpuMask, name: "X" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(msg);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(limitProcess).not.toHaveBeenCalled();
    expect(existsSync(join(cfg.serverProfilePath, "server.json"))).toBe(false);
  });

  it("on a platform other than Windows refuses cpuMask before anything is written or spawned", async () => {
    watch.platform = "linux";
    const r = await h({ action: "start", cpuMask: "0x3000", name: "X" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("cpuMask works on Windows only");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(limitProcess).not.toHaveBeenCalled();
    expect(existsSync(join(cfg.serverProfilePath, "server.json"))).toBe(false);
    expect(existsSync(instanceFile)).toBe(false);
  });

  it("stops only the server's PID and returns an error when the mask cannot be applied", async () => {
    vi.mocked(limitProcess).mockImplementation(() => false);
    const r = await h({ action: "start", cpuMask: "0x3000" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("**Server stopped**: cpuMask 0x3000 could not be applied to server PID 424242.");
    expect(killPids).toHaveBeenCalledTimes(1);
    expect(killPids).toHaveBeenCalledWith([424242], true, true);
    expect(existsSync(instanceFile)).toBe(false);
  });

  it("says the server is still running, and keeps its instance file, when the kill did not end it", async () => {
    vi.mocked(limitProcess).mockImplementation(() => false);
    vi.mocked(isAlive).mockImplementation(() => true);
    const r = await h({ action: "start", cpuMask: "0x3000" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("It is still running: server stop.");
    expect(existsSync(instanceFile)).toBe(true);
  });

  it("without cpuMask nothing is applied, killed or added to the reply", async () => {
    const r = await h({ action: "start" });
    expect(limitProcess).not.toHaveBeenCalled();
    expect(killPids).not.toHaveBeenCalled();
    expect(r.content[0].text).not.toContain("CPU:");
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it("the description and the cpuMask parameter say what it does", () => {
    let def!: { description: string; inputSchema: { cpuMask: { description?: string } } };
    registerServer({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, cfg);
    expect(def.description).toContain("start takes an optional hex cpuMask that pins the server to those cores at BelowNormal priority; the server is stopped if that fails.");
    expect(def.inputSchema.cpuMask.description).toMatch(/Hex CPU mask for the server, e\.g\. 0x3000.*BelowNormal.*Refused when it is not hex, is zero or names a core this PC does not have/);
  });
});
