import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerGameRead, isProbablyText } from "../../src/tools/game-read.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { buildTestPak, buildRdb } from "../pak/test-pak.js";
import { makeFakeStack, G } from "../pak/fake-stack.js";

// Fresh temp game per file: the rdb GUID map and the VFS singleton are cached per game path
const root = mkdtempSync(join(tmpdir(), "emcp-gr-"));
const data = join(root, "game", "addons", "data");
mkdirSync(join(data, "Prefabs"), { recursive: true });
const big = Array.from({ length: 20_000 }, (_, i) => `// line ${i}`).join("\n") + "\n";
writeFileSync(join(data, "data.pak"), buildTestPak([
  { path: "Scripts/Game/Big.c", content: big, compress: true },
  { path: "Configs/Hit.ct", content: "SCR_HitZone {\n m_fHealth 100\n}\n", compress: false },
  { path: "Prefabs/Char.et", content: "GenericEntity {\n}\n", compress: false },
  { path: "worlds/Arland.ent", content: "EBIN\u0001\u0002binary", compress: false },
]));
writeFileSync(join(data, "resourceDatabase.rdb"), buildRdb({ "Prefabs/Char.et": "37578B1666981FCE" }));
writeFileSync(join(data, "Prefabs", "Loose.et.meta"), 'MetaFileClass {\n Name "{ABCDEF0123456789}Prefabs/Loose.et"\n}\n');
const fake = makeFakeStack();
PakVirtualFS.invalidate();
afterAll(() => {
  PakVirtualFS.invalidate();
  rmSync(root, { recursive: true, force: true });
  rmSync(fake.root, { recursive: true, force: true });
});

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let read!: Handler;
registerGameRead({ registerTool: (_n: string, _d: unknown, h: Handler) => { read = h; } } as unknown as McpServer,
  { gamePath: join(root, "game"), projectPath: fake.config.projectPath, workshopPath: fake.config.workshopPath } as Config);
const text = async (a: Record<string, unknown>) => (await read(a)).content[0].text;

describe("game_read", () => {
  it("pages a large pak file, and the pages put together give the file back", async () => {
    const first = await text({ path: "Scripts/Game/Big.c" });
    expect(first).toMatch(/^\/\/ Scripts\/Game\/Big\.c \(from \.pak\) \| 20000 lines, \d+ bytes/);
    expect(first).toMatch(/\/\/ lines 1-400 of 20,000; continue with offset=400$/);
    let all = "", offset = 0;
    for (;;) {
      const t = await text({ path: "Scripts/Game/Big.c", offset, limit: 2000 });
      all += t.slice(t.indexOf("\n\n") + 2, t.lastIndexOf("// lines"));
      const next = t.match(/offset=(\d+)$/);
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(all).toBe(big);
    expect((await read({ path: "Scripts/Game/Big.c", offset: 20_000 })).isError).toBe(true);
  });

  it("accepts a {GUID} prefix, shows the GUID, reads .ct as text and refuses EBIN", async () => {
    expect(await text({ path: "{37578B1666981FCE}Prefabs/Char.et" })).toContain("(from .pak) {37578B1666981FCE}Prefabs/Char.et | 2 lines");
    expect(await text({ path: "Configs/Hit.ct" })).toContain("m_fHealth 100");
    expect(await text({ path: "worlds/Arland.ent" })).toMatch(/^Binary file: worlds\/Arland\.ent \(\.ent, \d+ bytes\)/);
    expect(await text({ path: "Scripts/Game" })).toBe('"Scripts/Game" is a directory. Use game_browse to list its contents.');
  });

  it("detects text by content", () => {
    expect(isProbablyText(Buffer.from("EBIN...."))).toBe(false);
    expect(isProbablyText(Buffer.from([0x41, 0x00, 0x42]))).toBe(false);
    expect(isProbablyText(Buffer.from("SCR_HitZoneContainer {\n\tm_x 1\r\n}"))).toBe(true);
    expect(isProbablyText(Buffer.from("Привет, мир {\n}", "utf-8"))).toBe(true);
  });

  it("synthesizes a .meta from the rdb, prefers a real one, and says when there is no GUID", async () => {
    const meta = await text({ path: "Prefabs/Char.et.meta" });
    expect(meta).toContain("is not shipped");
    expect(meta).toContain('Name "{37578B1666981FCE}Prefabs/Char.et"');
    expect(await text({ path: "Prefabs/Loose.et.meta" })).toContain("{ABCDEF0123456789}");
    const none = await read({ path: "Scripts/Game/Big.c.meta" });
    expect([none.isError, none.content[0].text]).toEqual([true, "No GUID for Scripts/Game/Big.c in resourceDatabase.rdb (scripts and .layer files have none)."]);
  });

  it("reads one addon's own layer with addon, and its .meta from that addon's rdb", async () => {
    const t = await text({ path: "Prefabs/Guerilla_Pants.et", addon: "ModB_BBBBBBBBBBBBBBBB" });
    expect(t).toContain(`(from ModB, workshop) {${G.guerilla}}Prefabs/Guerilla_Pants.et`);
    expect(await text({ path: "Prefabs/Guerilla_Pants.et.meta", addon: "BBBBBBBBBBBBBBBB" })).toContain(`{${G.guerilla}}`);
    expect((await read({ path: "Prefabs/Pants_BDU.et", addon: "ModB_BBBBBBBBBBBBBBBB" })).isError).toBe(true);
    expect((await read({ path: "x.et", addon: "Nope" })).content[0].text).toMatch(/No addon "Nope"/);
  });
});
