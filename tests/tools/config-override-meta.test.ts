import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { writeOverride } from "../../src/tools/config-override.js";
import { buildTestPak } from "../pak/test-pak.js";

// One rdb record the way 1.8 stores it (same layout as tests/pak/rdb.test.ts).
function record(path: string, guidHex: string): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(path.length + 1);
  return Buffer.concat([len, Buffer.from(path + "\0", "latin1"), Buffer.from([6, 0, 0, 0, 0, 0]), Buffer.from(guidHex, "hex").reverse(), Buffer.alloc(8)]);
}

const GUID = "E6FC4537B53EA00B";
const PATH = "Configs/Campaign/XPRewards.conf";
const root = mkdtempSync(join(tmpdir(), "emcp-com-"));
const data = join(root, "game", "addons", "data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "resourceDatabase.rdb"), Buffer.concat([Buffer.from("FORM\0\0\0\0RDBC"), record(PATH, GUID)]));
const pak = buildTestPak([{ path: PATH, content: "SCR_XPInfoConfig {\n m_iRewardXP 10\n}\n", compress: false }]);
// buildTestPak stores payload-relative offsets; the reader wants absolute ones (56 = start of the DATA payload, see vfs.test.ts).
pak.writeUInt32LE(56, pak.lastIndexOf("XPRewards.conf") + "XPRewards.conf".length);
writeFileSync(join(data, "data.pak"), pak);
const config = { gamePath: join(root, "game") } as Config;
const edits = (v: string) => [{ property: "m_iRewardXP", match: () => true, value: () => v }];

describe("writeOverride .meta", () => {
  it("writes the .meta when it is missing", () => {
    const addon = join(root, "a1");
    const r = writeOverride(config, addon, PATH, edits("20"));
    expect(r.changes.length).toBe(1);
    expect(readFileSync(r.file + ".meta", "utf-8")).toContain(`{${GUID}}${PATH}`);
  });

  it("keeps an existing .meta with the base GUID as it is", () => {
    const addon = join(root, "a2");
    const meta = join(addon, ...PATH.split("/")) + ".meta";
    mkdirSync(join(meta, ".."), { recursive: true });
    const full = `MetaFileClass {\n Name "{${GUID}}${PATH}"\n Configurations {\n  CONFResourceClass PC {\n  }\n }\n}\n`;
    writeFileSync(meta, full);
    writeOverride(config, addon, PATH, edits("30"));
    expect(readFileSync(meta, "utf-8")).toBe(full);
  });

  it("refuses when the existing .meta has another GUID, and writes nothing", () => {
    const addon = join(root, "a3");
    const file = join(addon, ...PATH.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file + ".meta", `MetaFileClass {\n Name "{1111111111111111}${PATH}"\n}\n`);
    expect(() => writeOverride(config, addon, PATH, edits("40"))).toThrow(/1111111111111111/);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(file + ".meta", "utf-8")).toContain("{1111111111111111}");
  });
});
