import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peFileVersion } from "../../src/utils/pe-version.js";
import { makePe } from "./make-pe.js";

const dir = mkdtempSync(join(tmpdir(), "emcp-pe-"));
const put = (name: string, data: Buffer | string): string => { const f = join(dir, name); writeFileSync(f, data); return f; };

describe("peFileVersion", () => {
  it("prefers the FileVersion string (the game exes keep 1.9.0.37 there and 1.9.0.0 in the numeric fields)", () => {
    expect(peFileVersion(put("string.exe", makePe({ fixed: [1, 9, 0, 0], fileVersion: "1.9.0.37" })))).toBe("1.9.0.37");
  });

  it("falls back to the numeric fields when there is no string table", () => {
    expect(peFileVersion(put("fixed.exe", makePe({ fixed: [1, 9, 0, 37] })))).toBe("1.9.0.37");
  });

  it("gives nothing for a missing file, a non-PE file, an empty file and a truncated exe", () => {
    const pe = makePe({ fixed: [1, 9, 0, 0], fileVersion: "1.9.0.37" });
    expect(peFileVersion(join(dir, "missing.exe"))).toBeUndefined();
    expect(peFileVersion(put("linux", Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(4096)])))).toBeUndefined();
    expect(peFileVersion(put("empty.exe", ""))).toBeUndefined();
    for (const cut of [30, 0x44, 0x200, 0x230, pe.length - 10]) expect(peFileVersion(put(`cut${cut}.exe`, pe.subarray(0, cut)))).toBeUndefined();
  });
});
