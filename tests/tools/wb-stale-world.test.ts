import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbConnect } from "../../src/tools/wb-connect.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";
import { registerWbState } from "../../src/tools/wb-state.js";
import type { Config } from "../../src/config.js";

// B-181: after an open that EMCP_WB_EditorControl refuses, a call into World Editor state crashed Workbench natively (6 of 6 live runs).
// The client marks that Workbench by the port owner's PID and refuses the state-reading handlers until a .ent opens. Nothing here runs
// netstat or PowerShell or talks to Workbench: worldProbe and rawCall are stubbed.

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const PORT = 5775;
const listening = (pid: number) => `  TCP    0.0.0.0:${PORT}    0.0.0.0:0    LISTENING    ${pid}\r\n`;
const STALE = "a refused open left the world in this Workbench in a state where this call can crash Workbench";
const STALE_LINE = `Refused: ${STALE}. Open a world with wb_open_resource (a .ent) or restart Workbench first. Nothing was sent.`;

function setup() {
  const env = { netstat: async (): Promise<string> => listening(4242), openFails: "" };
  const client = new WorkbenchClient("127.0.0.1", PORT);
  client.worldProbe = { netstat: () => env.netstat(), titles: async () => ({ wins: [] }) };
  const sent: string[] = [];
  vi.spyOn(client as unknown as { rawCall: (f: string, p: Record<string, unknown>) => Promise<unknown> }, "rawCall").mockImplementation(async (f, p) => {
    sent.push(f === "EMCP_WB_EditorControl" ? `${f}:${p.action}` : f);
    if (p.action === "openResource" && env.openFails) return { status: "error", message: env.openFails };
    if (f === "EMCP_WB_GetState") return { status: "ok", mode: "edit", entityCount: 1 };
    return { status: "ok", mode: "edit", message: "done" };
  });
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (n: string, _d: unknown, h: Handler) => (tools[n] = h) } as unknown as McpServer;
  registerWbEditorTools(server, client, {} as Config);
  registerWbEntityTools(server, client);
  registerWbState(server, client);
  registerWbConnect(server, client);
  const refuseOpen = async (path = "Worlds/NoSuchWorld.ent") => {
    env.openFails = `Workbench could not open: ${path} (use a path relative to an addon, e.g. Scripts/Game/X.c, or a {GUID}path)`;
    const r = await tools.wb_open_resource({ path });
    env.openFails = "";
    expect(r.isError).toBe(true);
    sent.length = 0;
  };
  return { env, client, tools, sent, refuseOpen };
}

describe("a refused open leaves the world stale", () => {
  it.each(["Worlds/NoSuchWorld.ent", "Prefabs/NoSuch.et"])("after a refused open of %s, wb_state and wb_entity_list refuse and send nothing", async (path) => {
    const s = setup();
    await s.refuseOpen(path);
    for (const [name, args] of [["wb_state", {}], ["wb_entity_list", {}]] as const) {
      const r = await s.tools[name](args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(STALE);
      expect(r.content[0].text).toContain("wb_open_resource (a .ent) or restart Workbench first");
    }
    expect(s.sent).toEqual([]);
  });

  it.each([["wb_play", {}], ["wb_entity_create", { prefab: "Prefabs/X.et", position: "0 0 0" }]] as const)(
    "%s reads no mode from Workbench and replies with the stale line, not a mode error",
    async (name, args) => {
      const s = setup();
      await s.refuseOpen();
      const r = await s.tools[name](args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(STALE_LINE);
      expect(r.content[0].text).not.toContain("could not read the Workbench mode");
      expect(s.sent).toEqual([]);
    }
  );

  it("an open reply without \"could not open\" marks nothing", async () => {
    const s = setup();
    s.env.openFails = "Unknown action: openResource";
    await s.tools.wb_open_resource({ path: "Worlds/A.ent" });
    s.env.openFails = "";
    expect((await s.tools.wb_state({})).isError).toBeUndefined();
  });

  it("a successful .ent open clears the mark; an open is never refused while marked", async () => {
    const s = setup();
    await s.refuseOpen();
    expect((await s.tools.wb_state({})).isError).toBe(true);
    expect((await s.tools.wb_open_resource({ path: "Worlds/Other.ent" })).isError).toBeUndefined();
    expect(s.sent).toEqual(["EMCP_WB_EditorControl:openResource"]);
    expect((await s.tools.wb_state({})).isError).toBeUndefined();
    expect(s.sent).toEqual(["EMCP_WB_EditorControl:openResource", "EMCP_WB_GetState"]);
  });

  it("a successful .et open does not clear the mark", async () => {
    const s = setup();
    await s.refuseOpen();
    await s.tools.wb_open_resource({ path: "Prefabs/A.et" });
    expect((await s.tools.wb_state({})).isError).toBe(true);
  });

  it("a different PID on the port is not marked, and the old mark is gone for good", async () => {
    const s = setup();
    await s.refuseOpen();
    expect((await s.tools.wb_state({})).isError).toBe(true);
    s.env.netstat = async () => listening(5151); // Workbench restarted
    expect((await s.tools.wb_state({})).isError).toBeUndefined();
    s.env.netstat = async () => listening(4242);
    expect((await s.tools.wb_state({})).isError).toBeUndefined();
  });

  it("with no netstat answer the marked Workbench is still refused", async () => {
    const s = setup();
    await s.refuseOpen();
    s.env.netstat = async () => "";
    expect((await s.tools.wb_state({})).content[0].text).toContain(STALE);
    s.env.netstat = () => Promise.reject(new Error("only Windows can be checked"));
    expect((await s.tools.wb_state({})).content[0].text).toContain(STALE);
  });

  it("wb_connect, which reads no World Editor state, still sends while marked", async () => {
    const s = setup();
    await s.refuseOpen();
    const r = await s.tools.wb_connect({});
    expect(r.isError).toBeUndefined();
    expect(s.sent).toContain("EMCP_WB_Ping");
  });

  it("nothing is marked when no open was refused", async () => {
    const s = setup();
    expect((await s.tools.wb_state({})).isError).toBeUndefined();
    expect((await s.tools.wb_entity_list({})).isError).toBeUndefined();
  });
});
