import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbExecuteAction } from "../../src/tools/wb-execute-action.js";

type Result = { content: { text: string }[]; isError?: boolean };

// Stub client in edit mode; the test only checks which menu paths reach call().
function tool() {
  const client = {
    state: { connected: true, mode: "edit" },
    probeMode: vi.fn(async () => "edit"),
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
