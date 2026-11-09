import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// A fake home first: the footer reads the watch folder under it, never the real one.
const home = mkdtempSync(join(tmpdir(), "emcp-wbl-home-"));
process.env.USERPROFILE = process.env.HOME = home;

// Nothing may be closed or killed by wb_launch.
const killed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  killPids: vi.fn(() => { killed.calls++; }),
}));

const { WorkbenchClient, WorkbenchError } = await import("../../src/workbench/client.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");

type Reply = { isError?: boolean; content: { text: string }[] };
function launchTool(config: Config, client: InstanceType<typeof WorkbenchClient>) {
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Reply>> = {};
  registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (typeof tools)[string]) => { tools[n] = h; } } as unknown as McpServer, config, client);
  return tools.wb_launch;
}

describe("wb_launch", () => {
  it("leaves defaultMod alone when the launch is refused", async () => {
    const config = { defaultMod: "TestAddon" } as Config;
    const client = new WorkbenchClient("127.0.0.1", 1);
    client.ping = async () => false;
    client.ensureRunning = async () => { throw new WorkbenchError("Refused: protected", "LAUNCH_FAILED"); };
    const tools: Record<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean }>> = {};
    registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (typeof tools)[string]) => { tools[n] = h; } } as unknown as McpServer, config, client);
    const r = await tools.wb_launch({ gprojPath: "C:\projects\Coalition-Reforger-Framework\addon.gproj" });
    expect(r.isError).toBe(true);
    expect(config.defaultMod).toBe("TestAddon");
  });
});

describe("wb_launch with a Workbench that already answers the port", () => {
  const LISTEN = "  TCP    0.0.0.0:5775           0.0.0.0:0              LISTENING       4321\r\n";
  const mine = join(home, "A", "addon.gproj");
  const other = join(home, "B", "addon.gproj");

  /** A client whose ping answers, with the netstat and process reads stubbed and counted. */
  function answering(opts: { host?: string; platform?: NodeJS.Platform; netstat?: string; proc?: string | null; owned?: boolean } = {}) {
    const client = new WorkbenchClient(opts.host ?? "127.0.0.1", 5775);
    const netstat = vi.fn(async () => opts.netstat ?? LISTEN);
    client.ping = async () => true;
    client.worldProbe = { netstat, titles: async () => ({ unavailable: "not reached" }) };
    const cmd = opts.proc === undefined ? `ArmaReforgerWorkbenchSteamDiag.exe -gproj "${other}" -addonsDir "x"` : opts.proc;
    client.ownerProbe = {
      platform: opts.platform ?? "win32",
      proc: async () => (cmd === null ? undefined : { pid: 4321, ppid: 1, cmd, created: 1 }),
      owned: () => opts.owned ?? false,
    };
    const ensureRunning = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
    return { client, netstat, ensureRunning };
  }

  it("refuses a different project: names PID, project and who started it; starts, saves and kills nothing", async () => {
    killed.calls = 0;
    const config = { defaultMod: "TestAddon" } as Config;
    for (const owned of [false, true]) {
      const { client, ensureRunning } = answering({ owned });
      const r = await launchTool(config, client)({ gprojPath: mine });
      expect(r.isError).toBe(true);
      const text = r.content[0].text;
      for (const part of ["PID 4321", other, owned ? "started by this MCP" : "not started by this MCP", "close it or ask whoever uses it"]) expect(text).toContain(part);
      if (owned) expect(text).not.toContain("not started by this MCP");
      expect(ensureRunning).not.toHaveBeenCalled();
    }
    expect(config.defaultMod).toBe("TestAddon");
    expect(killed.calls).toBe(0);
  });

  it("shares the same project, or any project when none is asked for, with the identity line", async () => {
    const config = { defaultMod: "TestAddon" } as Config;
    const same = answering({ proc: `ArmaReforgerWorkbenchSteamDiag.exe -gproj "${mine}"` });
    const r = await launchTool(config, same.client)({ gprojPath: mine });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Workbench Already Running");
    expect(r.content[0].text).toContain(`Workbench PID 4321 answers NET API port 5775: project ${mine}, not started by this MCP.`);
    expect(config.defaultMod).toBe("A");
    const none = answering();
    const r2 = await launchTool(config, none.client)({});
    expect(r2.isError).toBeUndefined();
    expect(r2.content[0].text).toContain(`project ${other}, not started by this MCP.`);
    expect(same.ensureRunning).not.toHaveBeenCalled();
    expect(none.ensureRunning).not.toHaveBeenCalled();
  });

  it("says 'project unknown' and does not refuse when the owner cannot be told", async () => {
    const cases: [string, ReturnType<typeof answering>, boolean][] = [
      ["no -gproj", answering({ proc: "ArmaReforgerWorkbenchSteamDiag.exe" }), true],
      ["netstat failed", answering({ netstat: "" }), true],
      ["process read failed", answering({ proc: null }), true],
      ["non-local host", answering({ host: "192.0.2.1" }), false],
      ["non-Windows", answering({ platform: "linux" }), false],
    ];
    for (const [why, { client, netstat }, runsNetstat] of cases) {
      const r = await launchTool({} as Config, client)({ gprojPath: mine });
      expect(r.isError, why).toBeUndefined();
      expect(r.content[0].text, why).toContain("project unknown");
      expect(netstat.mock.calls.length, why).toBe(runsNetstat ? 1 : 0);
    }
  });
});
