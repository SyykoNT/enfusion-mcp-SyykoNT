import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbExecuteAction } from "../../src/tools/wb-execute-action.js";

type Result = { content: { text: string }[]; isError?: boolean };

// Stub client (edit mode unless told otherwise); the test only checks which menu paths reach call().
function tool(mode = "edit") {
  const client = {
    state: { connected: true, mode },
    probeMode: vi.fn(async () => mode),
    endpoint: "127.0.0.1:5775",
    watchNote: vi.fn(async () => ""),
    call: vi.fn(async () => ({ executed: true })),
  };
  let handler: (a: { menuPath: string; module?: string }) => Promise<Result> = async () => ({ content: [] });
  registerWbExecuteAction({ registerTool: (_n: string, _d: unknown, h: typeof handler) => (handler = h) } as unknown as McpServer, client as unknown as WorkbenchClient);
  return { client, run: (menuPath: string, module = "WorldEditor") => handler({ menuPath, module }), raw: (a: { menuPath: string; module?: string }) => handler(a) };
}

describe("wb_execute_action block list", () => {
  it.each(["File,Save", "file, save world", " File , Save"])("blocks the World Editor save %j and points to wb_save", async (path) => {
    const t = tool();
    const r = await t.run(path);
    expect(r.content[0].text).toContain("**Blocked:**");
    expect(r.content[0].text).toContain("Use wb_save");
    expect(t.client.call).not.toHaveBeenCalled();
  });

  it("blocks File , Close, which slipped past the old untrimmed, case-sensitive check", async () => {
    const t = tool();
    expect((await t.run("File , Close")).content[0].text).toContain("Perform it manually in Workbench");
    expect(t.client.call).not.toHaveBeenCalled();
  });

  it("blocks File,Save with a missing or empty module, which the handler runs in the World Editor", async () => {
    const t = tool();
    expect((await t.raw({ menuPath: "File,Save" })).content[0].text).toContain("Use wb_save");
    expect((await t.raw({ menuPath: "File,Save", module: "" })).content[0].text).toContain("Use wb_save");
    expect(t.client.call).not.toHaveBeenCalled();
  });

  it("lets File,Save in another module and Game,Exit game through", async () => {
    const t = tool();
    await t.run("File,Save", "ScriptEditor");
    await t.run("Game,Exit game");
    expect(t.client.call).toHaveBeenCalledTimes(2);
  });
});

describe("wb_execute_action with no world open", () => {
  const PLUGIN = "Plugins,Coalition Lobby Mission Plugins,1 | Automatically Create Initial Layers/Objects";

  it("runs a ResourceManager action", async () => {
    const t = tool("no_world");
    await t.run("MCP,NoSuchItem", "ResourceManager");
    expect(t.client.call).toHaveBeenCalledTimes(1);
    expect(t.client.probeMode).toHaveBeenCalledTimes(1);
  });

  it.each([PLUGIN, PLUGIN.toLowerCase(), "  PLUGINS , Coalition Lobby Mission Plugins , 1 | Automatically Create Initial Layers/Objects"])(
    "runs the World Editor Plugins path %j",
    async (path) => {
      const t = tool("no_world");
      await t.run(path);
      expect(t.client.call).toHaveBeenCalledTimes(1);
      expect(t.client.probeMode).toHaveBeenCalledTimes(1);
    }
  );

  it("treats a missing module as the World Editor, so a Plugins path runs and Edit,Undo is refused", async () => {
    const t = tool("no_world");
    await t.raw({ menuPath: PLUGIN });
    expect(t.client.call).toHaveBeenCalledTimes(1);
    const r = await t.raw({ menuPath: "Edit,Undo" });
    expect(r.isError).toBe(true);
    expect(t.client.call).toHaveBeenCalledTimes(1);
  });

  it("still refuses other World Editor paths", async () => {
    const t = tool("no_world");
    const r = await t.run("Edit,Undo");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no world is open");
    expect(t.client.call).not.toHaveBeenCalled();
    expect(t.client.probeMode).toHaveBeenCalledTimes(1);
  });

  it("does not match a path that only starts with the letters plugins", async () => {
    const t = tool("no_world");
    expect((await t.run("PluginsExtra,Run")).isError).toBe(true);
    expect(t.client.call).not.toHaveBeenCalled();
  });

  it.each(["play", "not_running", "timeout", "no_handlers", "unknown"])("refuses a ResourceManager action in mode %s", async (mode) => {
    const t = tool(mode);
    const r = await t.run("MCP,NoSuchItem", "ResourceManager");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Cannot execute menu action");
    expect(t.client.call).not.toHaveBeenCalled();
    expect(t.client.probeMode).toHaveBeenCalledTimes(1);
  });

  it("refuses a Plugins path in play mode", async () => {
    const t = tool("play");
    expect((await t.run(PLUGIN)).isError).toBe(true);
    expect(t.client.call).not.toHaveBeenCalled();
  });

  it("still blocks File,Save in the World Editor with no world open", async () => {
    const t = tool("no_world");
    expect((await t.run("File,Save")).content[0].text).toContain("**Blocked:**");
    expect(t.client.call).not.toHaveBeenCalled();
    expect(t.client.probeMode).not.toHaveBeenCalled();
  });
});
