import { describe, it, expect, vi, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// A fake home first: the footer reads the watch folder under it, never the real one.
const home = mkdtempSync(join(tmpdir(), "emcp-wbc-home-"));
process.env.USERPROFILE = process.env.HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerWbConnect } = await import("../../src/tools/wb-connect.js");

const bundled = fileURLToPath(new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP", import.meta.url));
const LISTEN = "  TCP    0.0.0.0:5775           0.0.0.0:0              LISTENING       4321\r\n";
type Reply = { isError?: boolean; content: { text: string }[] };

/** wb_connect against a Workbench that answers; the port owner's -gproj is `gproj` (none: no -gproj). Nothing real is probed. */
function connect(gproj?: string, host = "127.0.0.1") {
  const client = new WorkbenchClient(host, 5775);
  client.ping = async () => true;
  client.call = (async () => ({ mode: "edit", message: "ok" })) as typeof client.call;
  const netstat = vi.fn(async () => LISTEN);
  client.worldProbe = { netstat, titles: async () => ({ unavailable: "not reached" }) };
  client.ownerProbe = {
    platform: "win32",
    proc: async () => ({ pid: 4321, ppid: 1, cmd: `ArmaReforgerWorkbenchSteamDiag.exe${gproj ? ` -gproj "${gproj}"` : ""}`, created: 1 }),
    owned: () => false,
  };
  let description = "";
  let tool!: () => Promise<Reply>;
  registerWbConnect({ registerTool: (_n: string, d: { description: string }, h: () => Promise<Reply>) => { description = d.description; tool = h; } } as unknown as McpServer, client);
  return { run: () => tool(), description, netstat };
}

function addonWithHandlers(opts: { stale?: boolean; missing?: boolean; none?: boolean } = {}) {
  const addon = mkdtempSync(join(tmpdir(), "emcp-wbc-"));
  writeFileSync(join(addon, "addon.gproj"), `GameProject {\n ID "A"\n GUID "4444444444444444"\n}\n`);
  const dir = join(addon, "Scripts", "WorkbenchGame", "EnfusionMCP");
  mkdirSync(dir, { recursive: true });
  if (!opts.none) cpSync(bundled, dir, { recursive: true });
  if (opts.stale) writeFileSync(join(dir, "EMCP_WB_Clipboard.c"), "// old\n");
  if (opts.missing) rmSync(join(dir, "EMCP_WB_Components.c"));
  return { addon, gproj: join(addon, "addon.gproj"), dir, cleanup: () => rmSync(addon, { recursive: true, force: true }) };
}
const snap = (dir: string) => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f)).toString("base64")}`).join("|");

describe("wb_connect and the handlers of the port owner's project", () => {
  it("adds one line with the counts when the owner's addon has stale and missing handlers, and writes nothing", async () => {
    const a = addonWithHandlers({ stale: true, missing: true });
    const before = snap(a.dir);
    const r = await connect(a.gproj).run();
    expect(r.isError).toBeUndefined();
    const text = r.content[0].text;
    expect(text).toContain(`Handlers in ${a.addon} differ from this MCP version (1 stale, 1 missing): run wb_handlers install with the user's OK, then restart Workbench.`);
    expect(text.match(/differ from this MCP version/g)).toHaveLength(1);
    expect(snap(a.dir)).toBe(before);
    a.cleanup();
  });

  it("says nothing when the handlers are current", async () => {
    const a = addonWithHandlers();
    expect((await connect(a.gproj).run()).content[0].text).not.toContain("differ from this MCP version");
    a.cleanup();
  });

  it("says nothing when the owner's project is unknown, the addon has no handlers of its own, or the host is not local", async () => {
    const stale = addonWithHandlers({ stale: true });
    const none = addonWithHandlers({ none: true });
    const cases: [string, ReturnType<typeof connect>][] = [
      ["no -gproj", connect(undefined)],
      ["no handlers in the addon", connect(none.gproj)],
      ["non-local host", connect(stale.gproj, "192.0.2.1")],
    ];
    for (const [why, c] of cases) expect((await c.run()).content[0].text, why).not.toContain("differ from this MCP version");
    expect(cases[2][1].netstat).not.toHaveBeenCalled();
    stale.cleanup();
    none.cleanup();
  });

  it("is described in the tool description", () => {
    expect(connect().description).toMatch(/stale or missing handler scripts/);
  });
});
