import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { dstProfileDirs, dstProfiles } from "../../src/tools/server-params.js";
import { registerScriptErrors } from "../../src/tools/script-errors.js";
import { registerLogWatch } from "../../src/tools/log-watch.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (p: Record<string, unknown>) => Promise<Result>;

// Temp Workbench profile (ENFUSION_WORKBENCH_PROFILE) whose settings dump names absolute DST profiles, so no real Documents folder is read.
let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const vme = (t: string, fn: string) => [`${t} SCRIPT    (E): Virtual Machine Exception`, "", "Reason: NULL pointer to instance", "", `Function: '${fn}'`, "Stack trace:", `Scripts/Game/X.c:1 Function ${fn}`, ""].join("\r\n");
const head = "---\r\nLog x started at 2026-11-02 10:00:00\r\n\r\n";
// The line format seen on this PC (no Profile, no peers set), plus a Profile and one PeerConfig block as the dump would hold them (block form unverified).
const dumpLine = (server: string, peer: string) =>
  `ScriptTools\\SCR_DedicatedServerPlugin=SCR_DedicatedServerPlugin {, " m_sProfile \\"${server}\\"", " m_bNoThrow 1", " m_iMaxFPS 30", " m_bRunPeers 1", ` +
  `" m_aPeersConfig {", "  PeerConfig \\"{5E3A1B2C3D4E5F60}\\" {", "   Profile \\"${peer}\\"", "  }", " }", }`;
const tools: Record<string, Handler> = {};
let config: Config;
let prev: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-dst-"));
  prev = process.env.ENFUSION_WORKBENCH_PROFILE;
  process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "wb");
  put("wb/logs/.keep", "");
  put("wb/profile/wbSettingsDump.ini", `Other=1\r\n${dumpLine(join(root, "dst", "server"), join(root, "dst", "Peer"))}\r\n`);
  put("dst/server/logs/logs_2026-11-02_10-00-00/error.log", head + vme("10:00:05.000", "ServerTick"));
  put("dst/Peer1/logs/logs_2026-11-02_10-00-02/error.log", head + vme("10:00:06.000", "PeerOneTick"));
  put("dst/Peer2/logs/logs_2026-11-02_10-00-03/error.log", head + vme("10:00:07.000", "PeerTwoTick"));
  put("dst/Peer2/logs/logs_2026-11-02_10-00-03/console.log", "10:00:07.000 SCRIPT       : joined\r\n");
  put("dst/PeerX/logs/logs_1/error.log", "not a numbered peer");
  config = { serverProfilePath: join(root, "mcp-server"), clientProfilesRoot: join(root, "clients"), projectPath: join(root, "projects") } as Config;
  const fake = { registerTool: (n: string, _d: unknown, h: Handler) => void (tools[n] = h) } as unknown as McpServer;
  registerScriptErrors(fake, config);
  registerLogWatch(fake, config);
});
afterAll(() => {
  process.env.ENFUSION_WORKBENCH_PROFILE = prev;
  rmSync(root, { recursive: true, force: true });
});

describe("Dedicated Server Tool logs (GI-14)", () => {
  it("reads the Profile names from Workbench's settings dump, with the plugin's defaults", () => {
    const thisPc = 'ScriptTools\\SCR_DedicatedServerPlugin=SCR_DedicatedServerPlugin {, " m_bNoThrow 0", " m_iLogBackend None", " m_iMaxFPS 30", " m_bRunPeers 0", }';
    expect(dstProfiles(thisPc)).toEqual({ server: "", peers: "PeerPlugin" });
    expect(dstProfiles(dumpLine("server", "Client"))).toEqual({ server: "server", peers: "Client" });
  });

  it("finds the server and every numbered peer folder; a relative Profile is under <Documents>\\My Games", () => {
    const d = dstProfileDirs(config);
    expect(d.server).toBe(join(root, "dst", "server"));
    expect(d.peers).toEqual([join(root, "dst", "Peer1"), join(root, "dst", "Peer2")]);
    writeFileSync(join(root, "wb", "profile", "wbSettingsDump.ini"), dumpLine("server", "PeerPlugin"));
    expect(dstProfileDirs(config, () => "D:\\Docs").server).toBe(join("D:\\Docs", "My Games", "server"));
    writeFileSync(join(root, "wb", "profile", "wbSettingsDump.ini"), dumpLine(join(root, "dst", "server"), join(root, "dst", "Peer")));
  });

  it("script_errors dstServer and dstPeers return that run's errors, peers merged", async () => {
    const s = await tools.script_errors({ source: "dstServer", sessions: 1, limit: 15, frames: 5 });
    expect(s.content[0].text).toContain("ServerTick");
    const p = await tools.script_errors({ source: "dstPeers", sessions: 1, limit: 15, frames: 5 });
    expect(p.isError).toBeUndefined();
    expect(p.content[0].text).toContain("2 sessions");
    expect(p.content[0].text).toContain("PeerOneTick");
    expect(p.content[0].text).toContain("PeerTwoTick");
    expect(p.content[0].text).not.toContain("ServerTick");
  });

  it("log_watch scans a peer by number and says when the tool has no server Profile", async () => {
    const r = await tools.log_watch({ action: "scan", source: "dstPeers", instance: "2", file: "console", match: "any", timeoutSec: 60, maxRows: 200, extract: ["(?<what>joined)"] });
    expect(r.content[0].text).toMatch(/^scan: 1 lines, 1 rows/);
    expect((await tools.log_watch({ action: "scan", source: "dstPeers", instance: "3", file: "console", match: "any", timeoutSec: 60, maxRows: 200 })).content[0].text).toMatch(/peers found: 2/);
    writeFileSync(join(root, "wb", "profile", "wbSettingsDump.ini"), dumpLine("", "Peer"));
    const e = await tools.script_errors({ source: "dstServer", sessions: 1, limit: 15, frames: 5 });
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toContain("has no Profile set");
  });
});
