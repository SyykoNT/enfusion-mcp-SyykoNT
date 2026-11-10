import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import type { TitleProbe } from "../../src/watchdog/probe.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { registerWbProjects } from "../../src/tools/wb-projects.js";
import { registerWbResources } from "../../src/tools/wb-resources.js";
import type { Config } from "../../src/config.js";

// B-089: a .ent open is refused while the open world's World Editor title ends in *. No test here runs netstat or PowerShell or reads a window:
// every client gets a stubbed worldProbe and a stubbed call().

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const PORT = 5775;
const LISTENING = `  TCP    0.0.0.0:${PORT}    0.0.0.0:0    LISTENING    4242\r\n`;
const DIRTY = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent*" };
const CLEAN = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent" };
const SAVEBITS = { cls: "Qt683QWindowToolSaveBits", text: "Arma Reforger Workbench" };
const MAIN = { cls: "Qt683QWindowIcon", text: "Enfusion Workbench - MCP Parity Test (throwaway)" };
// register needs an existing absolute file with no .meta
const regDir = mkdtempSync(join(tmpdir(), "emcp-wg-"));
const NEW_WORLD = join(regDir, "New.ent");
writeFileSync(NEW_WORLD, "");
afterAll(() => rmSync(regDir, { recursive: true, force: true }));
const TARGET = "worlds/MP/MpTest/MpTest_Empty.ent";

const TOOLS = [
  { name: "wb_open_resource", args: (p: string) => ({ path: p }), api: "EMCP_WB_EditorControl" },
  { name: "wb_projects", args: (p: string) => ({ action: "open", name: p }), api: "EMCP_WB_EditorControl" },
  { name: "wb_resources", args: (p: string) => ({ action: "open", path: p }), api: "EMCP_WB_Resources" },
];

const refusal = (world: string, path: string) =>
  `Refused: the world open in Workbench (${world}) has unsaved changes (its World Editor title ends in *). ` +
  `Opening ${path} now would show Workbench's "Loading world" save prompt, which blocks every MCP call until a person answers it. ` +
  "Run wb_save first, or save or discard the changes in Workbench, then try again.";
const warning = (why: string) =>
  `Could not check for unsaved changes (${why}); if the current world has unsaved edits, Workbench will show a blocking "Loading world" prompt.`;

interface Over {
  host?: string;
  netstat?: () => Promise<string>;
  titles?: (pid: number) => Promise<TitleProbe>;
}

function setup(over: Over = {}) {
  const client = new WorkbenchClient(over.host ?? "127.0.0.1", PORT);
  const netstat = vi.fn(over.netstat ?? (async () => LISTENING));
  const titles = vi.fn(over.titles ?? (async () => ({ wins: [MAIN, CLEAN] })));
  client.worldProbe = { netstat, titles };
  vi.spyOn(client, "probeMode").mockResolvedValue("edit"); // register and rebuild check the mode first
  const call = vi.spyOn(client, "call").mockResolvedValue({ status: "ok", message: "" });
  const handlers: Record<string, Handler> = {};
  const server = { registerTool: (n: string, _d: unknown, h: Handler) => (handlers[n] = h) } as unknown as McpServer;
  registerWbEditorTools(server, client, {} as Config);
  registerWbProjects(server, client);
  registerWbResources(server, client);
  return { client, call, netstat, titles, handlers };
}

describe("unsaved-world guard on a .ent open", () => {
  it.each(TOOLS)("$name: an unsaved world is refused with the exact text and nothing is sent to Workbench", async (t) => {
    const s = setup({ titles: async () => ({ wins: [SAVEBITS, MAIN, DIRTY] }) }); // the World Editor window is not first
    const r = await s.handlers[t.name](t.args(TARGET));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(refusal("MCPParity/Worlds/MCPParity.ent", TARGET));
    expect(s.call).not.toHaveBeenCalled();
    expect(s.titles).toHaveBeenCalledWith(4242);
  });

  it.each(TOOLS)("$name: a clean world sends the open with no extra line", async (t) => {
    const s = setup({ titles: async () => ({ wins: [SAVEBITS, CLEAN, MAIN] }) }); // the post-save window is a window, not a dialog
    const r = await s.handlers[t.name](t.args(TARGET));
    expect(r.isError).toBeUndefined();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.call.mock.calls[0][0]).toBe(t.api);
    expect(r.content[0].text).not.toContain("Could not check");
  });

  const cannotTell: [string, Over, string][] = [
    ["not Windows", { netstat: () => Promise.reject(new Error("only Windows can be checked")) }, "only Windows can be checked"],
    ["remote host", { host: "10.0.0.5" }, "the NET API host 10.0.0.5 is not this PC"],
    ["netstat failed", { netstat: async () => "" }, "the netstat query failed"],
    ["title read failed or timed out", { titles: async () => ({ unavailable: "the title read failed or took over 8 s (exit 1)" }) }, "the title read failed or took over 8 s (exit 1)"],
    ["zero visible windows", { titles: async () => ({ wins: [] }) }, "no window of Workbench PID 4242 is visible to this MCP, for example because it runs in another Windows session"],
    ["probe throws", { titles: () => Promise.reject(new Error("boom")) }, "boom"],
  ];

  it.each(cannotTell)("cannot tell (%s): the open is sent and one warning line says why", async (_n, over, why) => {
    for (const t of TOOLS) {
      const s = setup(over);
      const r = await s.handlers[t.name](t.args(TARGET));
      expect(r.isError).toBeUndefined();
      expect(s.call).toHaveBeenCalledTimes(1);
      expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
      expect(r.content[0].text).toContain(warning(why));
    }
  });

  it("a remote host reads neither netstat nor windows", async () => {
    const s = setup({ host: "192.168.1.9" });
    await s.handlers.wb_open_resource({ path: TARGET });
    expect(s.netstat).not.toHaveBeenCalled();
    expect(s.titles).not.toHaveBeenCalled();
  });

  it("the warning also shows when the open then fails", async () => {
    const s = setup({ netstat: async () => "" });
    s.call.mockRejectedValue(new Error("boom"));
    const r = await s.handlers.wb_open_resource({ path: TARGET });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(warning("the netstat query failed"));
  });

  it.each(TOOLS)("$name: no port owner skips the check and sends the open, so the usual connection error can come back", async (t) => {
    const s = setup({ netstat: async () => "Active Connections\r\n  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    1\r\n" });
    const r = await s.handlers[t.name](t.args(TARGET));
    expect(s.titles).not.toHaveBeenCalled();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).not.toContain("Could not check");
  });

  it("the default probe off Windows rejects without running netstat", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(new WorkbenchClient("127.0.0.1", PORT).worldProbe.netstat()).rejects.toThrow("only Windows can be checked");
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });

  const mustNotRun = () => {
    throw new Error("the unsaved-world check must not run for this target");
  };

  it.each([
    ["wb_open_resource", { path: "Prefabs/Weapons/AK47.et" }],
    ["wb_open_resource", { path: "Scripts/Game/MyScript.c" }],
    ["wb_projects", { action: "open", name: "MyMod" }],
    ["wb_resources", { action: "open", path: "Prefabs/A.et" }],
    ["wb_resources", { action: "register", path: NEW_WORLD }], // only action open can raise the prompt
    ["wb_resources", { action: "rebuild", path: "Worlds/New.ent" }],
    ["wb_resources", { action: "getInfo", path: "Worlds/Other.ent" }],
  ])("%s %j never runs the check", async (name, args) => {
    const s = setup({ netstat: mustNotRun, titles: mustNotRun });
    const r = await s.handlers[name](args);
    expect(r.isError).toBeUndefined();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.netstat).not.toHaveBeenCalled();
    expect(s.titles).not.toHaveBeenCalled();
  });

  // Live check on 1.9.0.37: a .gproj open on a world with unsaved changes raised the same "Loading world" prompt.
  const GPROJ = "C:/mods/MyMod/addon.gproj";

  describe.each([GPROJ, "C:/mods/MyMod/ADDON.GPROJ"])("a .gproj open of %s", (name) => {
    it.each(TOOLS)("$name on an unsaved world is refused with the Loading world text and nothing is sent", async (t) => {
      const s = setup({ titles: async () => ({ wins: [SAVEBITS, MAIN, DIRTY] }) });
      const r = await s.handlers[t.name](t.args(name));
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(refusal("MCPParity/Worlds/MCPParity.ent", name));
      expect(s.call).not.toHaveBeenCalled();
    });
  });

  it("wb_projects open of a .gproj on a clean world sends the open with no extra line", async () => {
    const s = setup({ titles: async () => ({ wins: [MAIN, CLEAN] }) });
    const r = await s.handlers.wb_projects({ action: "open", name: GPROJ });
    expect(r.isError).toBeUndefined();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).not.toContain("Could not check");
  });

  it("wb_projects open of a .gproj when the check cannot run is sent with one warning line", async () => {
    const s = setup({ netstat: async () => "" });
    const r = await s.handlers.wb_projects({ action: "open", name: GPROJ });
    expect(r.isError).toBeUndefined();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).toContain(warning("the netstat query failed"));
  });

  it("the wb_projects description names the prompt and the refusal", () => {
    let description = "";
    const server = { registerTool: (n: string, d: { description: string }) => n === "wb_projects" && (description = d.description) } as unknown as McpServer;
    registerWbProjects(server, new WorkbenchClient("127.0.0.1", PORT));
    expect(description).toContain('Opening a .gproj or a .ent while the current world has unsaved changes makes Workbench ask "Loading world"');
    expect(description).toContain("so open refuses then");
  });

  it("the wb_resources description names the .ent and .gproj refusal", () => {
    let description = "";
    const server = { registerTool: (n: string, d: { description: string }) => n === "wb_resources" && (description = d.description) } as unknown as McpServer;
    registerWbResources(server, new WorkbenchClient("127.0.0.1", PORT));
    expect(description).toContain("open of a world (.ent) or a project (.gproj) is refused when the World Editor title shows unsaved changes or a layer made with wb_layers is not saved yet");
  });

  it.each([TARGET, "{4F2A9B1C3D5E7F80}Worlds/Other.ent", "Worlds/Other.ENT"])("%s counts as a world, with or without a GUID prefix", async (path) => {
    const s = setup({ titles: async () => ({ wins: [DIRTY] }) });
    const r = await s.handlers.wb_open_resource({ path });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(refusal("MCPParity/Worlds/MCPParity.ent", path));
    expect(s.call).not.toHaveBeenCalled();
  });

  it("the tool description says it refuses on unsaved changes and counts a layer this MCP created", async () => {
    let description = "";
    const server = { registerTool: (n: string, d: { description: string }) => n === "wb_open_resource" && (description = d.description) } as unknown as McpServer;
    registerWbEditorTools(server, new WorkbenchClient("127.0.0.1", PORT), {} as Config);
    expect(description).toContain("refuses a .ent or .gproj open when the World Editor title shows unsaved changes");
    expect(description).toContain("A layer this MCP created with wb_layers counts as unsaved until wb_save runs");
    expect(description).not.toContain("is not detected");
    expect(description).not.toContain("cannot tell whether the world has unsaved changes");
  });
});
