import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// A user without CRF and COALITION-Lobby (D-049): every Coalition tool must answer in words, start nothing and show no stack.
const empty = (name: string) => mkdtempSync(join(tmpdir(), `emcp-nocopies-${name}-`));
const home = empty("home");
const spawned = vi.hoisted(() => ({ calls: [] as string[] }));

// The guide's Projects folder is looked up under My Games; point it at an empty folder so a real install here cannot answer.
vi.mock("../../src/utils/game-paths.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/game-paths.js")>()), myGamesDir: () => home }));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  spawnDetached: (exe: string) => (spawned.calls.push(exe), 1),
  serverProcesses: () => [],
  clientProcesses: () => [],
}));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((exe: string) => (spawned.calls.push(exe), actual.spawn(process.execPath, ["-e", ""]))) };
});

const { registerCoalitionDoctor } = await import("../../src/tools/coalition-doctor.js");
const { registerMissionInspect } = await import("../../src/tools/mission-inspect.js");
const { registerGearscriptInspect } = await import("../../src/tools/gearscript-inspect.js");
const { registerMissionNames } = await import("../../src/tools/mission-names.js");
const { registerMissionGit } = await import("../../src/tools/mission-git.js");
const { registerMissionPrDraft } = await import("../../src/tools/mission-pr-draft.js");
const { registerMissionValidate } = await import("../../src/tools/mission-validate.js");
const { registerMissionPreflight } = await import("../../src/tools/mission-preflight.js");
const { registerServerParams } = await import("../../src/tools/server-params.js");
const { registerMissionServer } = await import("../../src/tools/mission-server.js");

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const config = {
  projectPath: empty("projects"),
  workshopPath: empty("workshop"),
  gamePath: empty("game"),
  serverPath: empty("server"),
  workbenchPath: empty("tools"),
} as Config;

function tool(register: (s: McpServer, c: Config) => void): Handler {
  let h: Handler = async () => ({ content: [] });
  register({ registerTool: (_n: string, _d: unknown, handler: Handler) => { h = handler; } } as unknown as McpServer, config);
  return h;
}

const noStack = (text: string) => expect(text).not.toMatch(/^\s+at /m);
const names = /CRF|Coalition-Reforger-Framework|COALITION-Lobby|Lobby/;

describe("Coalition tools without CRF or Lobby", { timeout: 30_000 }, () => {
  it("coalition_doctor reports both as not found and is not an error", async () => {
    const r = await tool(registerCoalitionDoctor)({});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/CRF/);
    expect(r.content[0].text).toMatch(/Lobby/);
    noStack(r.content[0].text);
  });

  const refusing: [string, (s: McpServer, c: Config) => void, Record<string, unknown>][] = [
    ["mission_inspect", registerMissionInspect, { world: "Worlds/Arland/X.ent", format: "markdown" }],
    ["gearscript_inspect", registerGearscriptInspect, { gearscript: "COA_GS_X.conf" }],
    ["mission_names build", registerMissionNames, { action: "build", author: "A", mode: "TVT", name: "N", terrain: "Arland" }],
    ["mission_names check", registerMissionNames, { action: "check", world: "Worlds/Arland/X.ent" }],
    ["mission_git", registerMissionGit, {}],
    ["mission_pr_draft", registerMissionPrDraft, {}],
    ["mission_validate", registerMissionValidate, { world: "Worlds/Arland/X.ent", checks: ["qa", "synopsis"] }],
  ];
  it.each(refusing)("%s refuses in words that name CRF or Lobby", async (_n, register, args) => {
    const r = await tool(register)(args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(names);
    noStack(r.content[0].text);
  });

  it("mission_preflight refuses or marks its steps not run, without a stack", async () => {
    const r = await tool(registerMissionPreflight)({});
    expect(r.content[0].text).toMatch(names);
    noStack(r.content[0].text);
  });

  it("server_params needs no CRF", async () => {
    const dir = join(empty("sp"), "Mission");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "addon.gproj"), 'GameProject {\n ID "Mission"\n GUID "AAAAAAAAAAAAAAAA"\n}\n');
    const r = await tool(registerServerParams)({ projectsFolder: dir, modsFolder: dir });
    expect(r.isError).toBeFalsy();
    noStack(r.content[0].text);
  });

  it("mission_server names what is missing and starts nothing", async () => {
    const handler = tool(registerMissionServer);
    const noWorld = await handler({ action: "start", world: join(config.projectPath, "None", "X.ent"), port: 2521, peers: 0, timeoutSec: 10, joinTimeoutSec: 1 });
    expect(noWorld.isError).toBe(true);
    expect(noWorld.content[0].text).toMatch(/existing absolute \.ent path/);

    const addon = join(empty("ms"), "Mission");
    mkdirSync(join(addon, "Worlds"), { recursive: true });
    writeFileSync(join(addon, "addon.gproj"), 'GameProject {\n ID "Mission"\n GUID "BBBBBBBBBBBBBBBB"\n}\n');
    writeFileSync(join(addon, "Worlds", "X.ent"), "");
    const noExe = await handler({ action: "start", world: join(addon, "Worlds", "X.ent"), port: 2522, peers: 0, timeoutSec: 10, joinTimeoutSec: 1 });
    expect(noExe.isError).toBe(true);
    expect(noExe.content[0].text).toMatch(/Not found: .*ArmaReforgerServerDiag\.exe \(set ENFUSION_SERVER_PATH\)/);
    noStack(noExe.content[0].text);
    expect(spawned.calls).toEqual([]);
  });
});
