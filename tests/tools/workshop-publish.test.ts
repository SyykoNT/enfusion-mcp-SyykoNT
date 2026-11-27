import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// No real Workbench: the publish run is stubbed.
vi.mock("../../src/workbench/cli.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/workbench/cli.js")>()),
  publishAddon: vi.fn(),
}));
const cli = await import("../../src/workbench/cli.js");
const { registerWorkshopPublish } = await import("../../src/tools/workshop-publish.js");

const root = mkdtempSync(join(tmpdir(), "emcp-wsp-"));
const projects = join(root, "projects");
mkdirSync(join(projects, "Alpha"), { recursive: true });
writeFileSync(join(projects, "Alpha", "addon.gproj"), `GameProject {\n ID "Alpha"\n GUID "AAAA000000000001"\n TITLE "Alpha"\n}\n`);
const image = join(root, "preview.png");
writeFileSync(image, "");
const config = { projectPath: projects, gamePath: join(root, "game"), workbenchPath: join(root, "tools"), workshopPath: join(root, "workshop"), defaultMod: "Alpha" } as Config;

type Result = { content: { text: string }[]; isError?: boolean };
let call: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
registerWorkshopPublish({ registerTool: (_n: string, _d: unknown, h: typeof call) => { call = h; } } as unknown as McpServer, config);
// The zod defaults are applied by the MCP server, not by the handler.
const run = (a: Record<string, unknown>) => call({ timeoutSec: 600, dryRun: true, confirm: false, ...a });

const run0 = { exitCode: 0, timedOut: false, seconds: 40, logDir: join(root, "logs", "x"), console: "" };
beforeEach(() => vi.mocked(cli.publishAddon).mockReset());

describe("workshop_publish", () => {
  it("is a dry run by default and shows the -publishAddon command line", async () => {
    const r = await run({ version: "1.2.3", changeNote: "Fix spawn points", previewImage: image });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Nothing was uploaded");
    expect(r.content[0].text).toContain("-publishAddon -noThrow -publishAddonVersion 1.2.3 -publishAddonChangeNote \"Fix spawn points\"");
    expect(cli.publishAddon).not.toHaveBeenCalled();
  });

  it("does not upload with dryRun false alone, or with confirm alone", async () => {
    await run({ dryRun: false });
    await run({ confirm: true });
    expect(cli.publishAddon).not.toHaveBeenCalled();
  });

  it("refuses bad values before Workbench starts", async () => {
    for (const a of [{ version: "1.2.3; x" }, { changeNote: "two\nlines" }, { previewImage: "rel/preview.png" }, { screenshotsDir: image }, { publishDir: join(root, "game", "out") }]) {
      const r = await run({ ...a, dryRun: false, confirm: true });
      expect(r.isError).toBe(true);
    }
    expect((await run({ modName: "Missing" })).isError).toBe(true);
    expect(cli.publishAddon).not.toHaveBeenCalled();
  });

  it("uploads only with dryRun false and confirm true, and reports the Workshop page", async () => {
    vi.mocked(cli.publishAddon).mockResolvedValue({ ok: true, run: run0, lines: ["Project uploaded successfully"], errors: [] });
    const r = await run({ version: "1.2.4", dryRun: false, confirm: true });
    expect(cli.publishAddon).toHaveBeenCalledOnce();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("uploaded");
    expect(r.content[0].text).toContain("https://reforger.armaplatform.com/workshop/AAAA000000000001");
  });

  it("reports a stalled run as an error that points to the GUI publish", async () => {
    vi.mocked(cli.publishAddon).mockResolvedValue({ ok: false, run: { ...run0, timedOut: true }, lines: [], errors: [] });
    const r = await run({ dryRun: false, confirm: true, timeoutSec: 60 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("ended after 60 s");
  });
});

describe("publishVerdict", () => {
  it("needs the upload line and no (E) line after Publishing project", () => {
    expect(cli.publishVerdict("x\r\nPublishing project\r\nProject uploaded successfully\r\n")).toMatchObject({ uploaded: true, errors: [] });
    const bad = cli.publishVerdict("12:00 WORKSHOP (E): early\r\nPublishing project\r\n12:01 WORKSHOP (E): Upload failed\r\n");
    expect(bad).toMatchObject({ uploaded: false, errors: ["Upload failed"] });
  });
});
