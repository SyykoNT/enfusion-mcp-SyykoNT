import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbResources } from "../../src/tools/wb-resources.js";

const dir = mkdtempSync(join(tmpdir(), "emcp-res-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** A new file that exists on disk and has no .meta: what register accepts. */
const newFile = (name = "A.et") => { const f = join(dir, `${++n}_${name}`); writeFileSync(f, ""); return f; };

type Reply = { content: { text: string }[]; isError?: boolean };

function setup(message: string) {
  const call = vi.fn(async () => ({ status: "ok", message }));
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call };
  let h!: (a: Record<string, unknown>) => Promise<Reply>;
  let description = "";
  registerWbResources({ registerTool: (_n: string, d: { description: string }, f: typeof h) => { h = f; description = d.description; } } as unknown as McpServer, client as never);
  return Object.assign(h, { call, description });
}

describe("wb_resources rebuild", () => {
  it("says the rebuild was requested and that the result is only in console.log, once", async () => {
    const msg = "Rebuild requested for: Prefabs/A.et. Workbench reports the result only in console.log.";
    const text = (await setup(msg)({ action: "rebuild", path: "Prefabs/A.et" })).content[0].text;
    expect(text).toContain("**Rebuild requested for: Prefabs/A.et. Workbench reports the result only in console.log.**");
    expect(text).not.toMatch(/Rebuilt/);
    expect(text.split("only in console.log").length).toBe(2);
  });

  it("register still shows the handler message", async () => {
    const f = newFile();
    const r = await setup("done")({ action: "register", path: f });
    expect(r.content[0].text).toContain(`**Registered resource: ${f}**\n\ndone`);
  });

  it("register reports a false return from RegisterResourceFile as a failure, not as registered", async () => {
    const f = newFile();
    const r = await setup(`RegisterResourceFile returned false for: ${f}`)({ action: "register", path: f });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`**Not registered: ${f}**`);
    expect(r.content[0].text).not.toMatch(/Registered resource/);
  });

  it("open reports a false return from SetOpenedResource as a failure, not as opened", async () => {
    const r = await setup("SetOpenedResource returned false for: Prefabs/A.et")({ action: "open", path: "Prefabs/A.et" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Not opened: Prefabs/A.et**");
    expect(r.content[0].text).not.toMatch(/Opened resource/);
  });

  it("a success whose path contains 'returned false' stays a success for register and open", async () => {
    const f = newFile("returned false.et");
    const reg = await setup(`Resource registered: ${f}`)({ action: "register", path: f });
    expect(reg.isError).toBeUndefined();
    expect(reg.content[0].text).toContain(`**Registered resource: ${f}**`);
    const open = await setup("Opened resource: Prefabs/returned false.et")({ action: "open", path: "Prefabs/returned false.et" });
    expect(open.isError).toBeUndefined();
    expect(open.content[0].text).toContain("**Opened resource: Prefabs/returned false.et**");
  });
});

describe("wb_resources register refuses a bad path before Workbench is called", () => {
  const refused = async (path: string, why: RegExp) => {
    const h = setup("done");
    const r = await h({ action: "register", path });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`**Not registered: ${path}**`);
    expect(r.content[0].text).toMatch(why);
    expect(h.call).not.toHaveBeenCalled();
  };

  it("a relative path", async () => {
    newFile("Rel.et"); // exists under the temp folder, but the path given is relative
    await refused("Prefabs/A.et", /not absolute/);
  });

  it("a file that does not exist", async () => {
    await refused(join(dir, "missing.et"), /does not exist/);
  });

  it("a file whose .meta exists", async () => {
    const f = newFile("Meta.et");
    writeFileSync(`${f}.meta`, "");
    await refused(f, /already has a .meta/);
  });

  it("a new absolute file calls Workbench as before", async () => {
    const h = setup("done");
    const f = newFile();
    expect((await h({ action: "register", path: f })).isError).toBeUndefined();
    expect(h.call).toHaveBeenCalledWith("EMCP_WB_Resources", { action: "register", path: f });
  });

  it("the description says what is refused", () => {
    expect(setup("").description).toMatch(/absolute path of a file that exists on disk and has no .meta yet/);
  });

  it("the other actions take any path", async () => {
    const h = setup("done");
    await h({ action: "open", path: "Prefabs/A.et" });
    expect(h.call).toHaveBeenCalledTimes(1);
  });
});
