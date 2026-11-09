import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_HOME, SERVER_DOWNLOAD_DIR, type Config } from "../../src/config.js";
import { registerServer, unpack } from "../../src/tools/server.js";
import { spawnDetached } from "../../src/utils/process.js";

// The downloads folder moves to a temp path that does not exist yet, so start creating it is visible and the real home stays untouched.
vi.mock("../../src/config.js", async (importActual) => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { ...(await importActual<typeof import("../../src/config.js")>()), SERVER_DOWNLOAD_DIR: join(tmpdir(), `emcp-srv-dl-${process.pid}-${Date.now()}`) };
});

// No real process is started or queried: start "spawns" a fake PID that is already gone.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  spawnDetached: vi.fn(() => 424242),
  serverProcesses: vi.fn(() => []),
  isAlive: vi.fn(() => false),
  sleep: vi.fn(async () => {}),
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
