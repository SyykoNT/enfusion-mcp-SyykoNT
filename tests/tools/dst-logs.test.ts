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

// The line format seen on this PC (no Profile, no peers set), plus a Profile and PeerConfig blocks as the dump would hold them (block form unverified).
type Peer = { profile?: string; enabled?: boolean };
const q = (s: string) => `\\"${s}\\"`;
const peerBlock = (p: Peer) =>
  `"  PeerConfig ${q("{5E3A1B2C3D4E5F60}")} {", ` + (p.profile !== undefined ? `"   Profile ${q(p.profile)}", ` : "") + (p.enabled === false ? `"   Enabled 0", ` : "") + `"  }", `;
const dumpLine = (server: string, peers: Peer[]) =>
  `ScriptTools\\SCR_DedicatedServerPlugin=SCR_DedicatedServerPlugin {, " m_sProfile ${q(server)}", " m_bNoThrow 1", " m_iMaxFPS 30", " m_bRunPeers 1", ` +
  `" m_aPeersConfig {", ${peers.map(peerBlock).join("")}" }", }`;
const setDump = (server: string, peers: Peer[]) => writeFileSync(join(root, "wb", "profile", "wbSettingsDump.ini"), `Other=1\r\n${dumpLine(server, peers)}\r\n`);
const twoPeers = (): Peer[] => [{ profile: join(root, "dst", "Peer") }, { profile: join(root, "dst", "Peer") }];

const tools: Record<string, Handler> = {};
let config: Config;
let prev: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-dst-"));
  prev = process.env.ENFUSION_WORKBENCH_PROFILE;
  process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "wb");
  put("wb/logs/.keep", "");
  put("wb/profile/wbSettingsDump.ini", "");
  setDump(join(root, "dst", "server"), twoPeers());
  put("dst/server/logs/logs_2026-11-02_10-00-00/error.log", head + vme("10:00:05.000", "ServerTick"));
  put("dst/server/notlogs/secret.log", "10:00:00.000 SCRIPT       : secret\r\n");
  put("dst/Peer1/logs/logs_2026-11-02_10-00-02/error.log", head + vme("10:00:06.000", "PeerOneTick"));
  put("dst/Peer2/logs/logs_2026-11-02_10-00-03/error.log", head + vme("10:00:07.000", "PeerTwoTick"));
  put("dst/Peer2/logs/logs_2026-11-02_10-00-03/console.log", "10:00:07.000 SCRIPT       : joined\r\n");
  // Left from an older run with three peers; the tool now has two.
  put("dst/Peer3/logs/logs_2026-10-01_10-00-00/error.log", head + vme("10:00:08.000", "OldRunPeerThree"));
  config = { serverProfilePath: join(root, "mcp-server"), clientProfilesRoot: join(root, "clients"), projectPath: join(root, "projects") } as Config;
  const fake = { registerTool: (n: string, _d: unknown, h: Handler) => void (tools[n] = h) } as unknown as McpServer;
  registerScriptErrors(fake, config);
  registerLogWatch(fake, config);
});
afterAll(() => {
  if (prev === undefined) delete process.env.ENFUSION_WORKBENCH_PROFILE;
  else process.env.ENFUSION_WORKBENCH_PROFILE = prev;
  rmSync(root, { recursive: true, force: true });
});

const scan = (p: Record<string, unknown>) => tools.log_watch({ action: "scan", file: "console", match: "any", timeoutSec: 60, maxRows: 200, ...p });

describe("Dedicated Server Tool logs (GI-14)", () => {
  it("reads each peer's own Profile from Workbench's settings dump, numbered over enabled peers as the plugin does", () => {
    const thisPc = 'ScriptTools\\SCR_DedicatedServerPlugin=SCR_DedicatedServerPlugin {, " m_bNoThrow 0", " m_iLogBackend None", " m_iMaxFPS 30", " m_bRunPeers 0", }';
    expect(dstProfiles(thisPc)).toEqual({ server: "", peers: [] });
    // Default Profile, own Profile, a disabled peer (not counted), Profile "" (counted, but no -profile so no folder), own Profile again.
    expect(dstProfiles(dumpLine("server", [{}, { profile: "Client" }, { profile: "Off", enabled: false }, { profile: "" }, { profile: "Client" }]))).toEqual({
      server: "server",
      peers: ["PeerPlugin1", "Client2", "Client4"],
    });
  });

  it("finds the server and the configured peers' folders; a relative Profile is under <Documents>\\My Games; .. is dropped", () => {
    const d = dstProfileDirs(config);
    expect(d.server).toBe(join(root, "dst", "server"));
    expect(d.peers).toEqual([join(root, "dst", "Peer1"), join(root, "dst", "Peer2")]);
    setDump("server", []);
    expect(dstProfileDirs(config, () => "D:\\Docs").server).toBe(join("D:\\Docs", "My Games", "server"));
    setDump("..\\..\\..", [{ profile: "..\\Peer" }]);
    expect(dstProfileDirs(config, () => "D:\\Docs")).toMatchObject({ server: undefined, peers: [] });
    setDump(join(root, "dst", "server"), twoPeers());
  });

  it("script_errors dstServer and dstPeers return that run's errors, peers merged, an older run's extra peer left out", async () => {
    const s = await tools.script_errors({ source: "dstServer", sessions: 1, limit: 15, frames: 5 });
    expect(s.content[0].text).toContain("ServerTick");
    const p = await tools.script_errors({ source: "dstPeers", sessions: 1, limit: 15, frames: 5 });
    expect(p.isError).toBeUndefined();
    expect(p.content[0].text).toContain("2 sessions");
    expect(p.content[0].text).toContain("PeerOneTick");
    expect(p.content[0].text).toContain("PeerTwoTick");
    expect(p.content[0].text).not.toContain("ServerTick");
    expect(p.content[0].text).not.toContain("OldRunPeerThree");
  });

  it("log_watch roots are each profile's logs folder only (review B1): a .log elsewhere is refused, even for a drive-root Profile", async () => {
    const outside = join(root, "dst", "server", "notlogs", "secret.log");
    expect((await scan({ source: "path", path: outside })).content[0].text).toBe(`Path is not under an allowed log root: ${outside}`);
    setDump("C:\\", []);
    expect((await scan({ source: "path", path: outside })).content[0].text).toMatch(/^Path is not under an allowed log root/);
    setDump(join(root, "dst", "server"), twoPeers());
    expect((await scan({ source: "path", path: join(root, "dst", "server", "logs"), file: "error" })).isError).toBeUndefined();
  });

  it("log_watch scans a peer by number and says when the tool has no server Profile", async () => {
    expect((await scan({ source: "dstPeers", instance: "2", extract: ["(?<what>joined)"] })).content[0].text).toMatch(/^scan: 1 lines, 1 rows/);
    expect((await scan({ source: "dstPeers", instance: "3" })).content[0].text).toMatch(/peers found: 2/);
    setDump("", twoPeers());
    const e = await tools.script_errors({ source: "dstServer", sessions: 1, limit: 15, frames: 5 });
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toContain("has no Profile set");
  });
});
