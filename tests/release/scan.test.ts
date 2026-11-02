import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPngJpegSize, walkAddon } from "../../src/release/scan.js";

/** PNG signature and IHDR only: enough for the header reader, not a real image. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("walkAddon", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-walk-"));
  const put = (rel: string, text: string) => { mkdirSync(join(dir, dirname(rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  put("Prefabs/Moved.et", "GenericEntity {\n}\n");
  put("Prefabs/Moved.et.meta", 'MetaFileClass {\n Name "{1111111111111111}Prefabs/Old/Moved.et"\n}\n');
  put("NavMesh/.NavData/x.ntile", "tile");
  put(".git/HEAD", "ref: refs/heads/main\n");
  put("NoName.conf.meta", "MetaFileClass {\n}\n");
  const outside = mkdtempSync(join(tmpdir(), "emcp-walk-out-"));
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(outside, join(dir, "Linked"), "junction");

  it("walks dot folders that ship, skips .git and links, and reads meta names", () => {
    const s = walkAddon(dir);
    expect(s.files.map((f) => f.rel).sort()).toEqual(["NavMesh/.NavData/x.ntile", "NoName.conf.meta", "Prefabs/Moved.et", "Prefabs/Moved.et.meta"]);
    expect(s.files.find((f) => f.rel === "NavMesh/.NavData/x.ntile")?.size).toBe(4);
    expect(s.metas).toEqual([
      { rel: "NoName.conf.meta", guid: "", namePath: "" },
      { rel: "Prefabs/Moved.et.meta", guid: "1111111111111111", namePath: "Prefabs/Old/Moved.et" },
    ]);
    expect(s.unreadable).toEqual([]);
  });
});

describe("readPngJpegSize", () => {
  it("reads PNG IHDR", () => {
    expect(readPngJpegSize(pngHeader(1920, 1080))).toEqual({ format: "png", width: 1920, height: 1080 });
  });

  it("skips JPEG segments to the frame header", () => {
    // SOI, APP0 (length 4), DHT C4 (length 4, must be skipped), SOF0 with height 720 and width 1280
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc4, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0]);
    expect(readPngJpegSize(jpg)).toEqual({ format: "jpeg", width: 1280, height: 720 });
  });

  it("returns null for other data", () => {
    expect(readPngJpegSize(Buffer.from("GIF89a........................"))).toBeNull();
    expect(readPngJpegSize(Buffer.alloc(0))).toBeNull();
  });
});
