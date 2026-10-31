import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";
import { registerWbLaunch } from "../../src/tools/wb-launch.js";

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
