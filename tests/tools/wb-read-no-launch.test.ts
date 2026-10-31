import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import type { Config } from "../../src/config.js";
import { registerWbState } from "../../src/tools/wb-state.js";
import { registerWbConnect } from "../../src/tools/wb-connect.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";
import { registerWbReadProps } from "../../src/tools/wb-read-props.js";
import { registerWbTerrain } from "../../src/tools/wb-terrain.js";
import { registerWbValidate } from "../../src/tools/wb-validate.js";
import { registerWbLayers } from "../../src/tools/wb-layers.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (a: Record<string, unknown>) => Promise<Result>;

// Port 1 refuses; the client has a config, so call() used to launch Workbench here. Only wb_launch may (D-025).
function setup() {
  const client = new WorkbenchClient("127.0.0.1", 1, {} as Config);
  const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
  const tools: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _d: unknown, h: Handler) => { tools[name] = h; } } as unknown as McpServer;
  for (const register of [registerWbState, registerWbConnect, registerWbEntityTools, registerWbReadProps, registerWbTerrain, registerWbValidate, registerWbLayers, registerWbEditorTools]) {
    register(fake, client);
  }
  return { tools, launch };
}

describe("wb_* tools other than wb_launch with Workbench down", () => {
  it.each([
    ["wb_state", {}],
    ["wb_connect", {}],
    ["wb_entity_list", { offset: 0, limit: 10 }],
    ["wb_entity_inspect", { name: "MCP_ParityBarrel" }],
    ["wb_read_props", { resource: "Prefabs/x.et" }],
    ["wb_terrain", { action: "getBounds" }],
    ["wb_validate", { action: "material", path: "x.emat" }],
    ["wb_layers", { action: "list" }], // read action of a gated tool
    ["wb_open_resource", { path: "Worlds/x.ent" }], // ungated mutating tool
  ])("%s returns an error and starts nothing", async (name, args) => {
    const { tools, launch } = setup();
    const result = await tools[name](args);
    expect(result.isError).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    if (name !== "wb_connect") expect(result.content[0].text).toContain("Tools do not start Workbench");
  });
});
