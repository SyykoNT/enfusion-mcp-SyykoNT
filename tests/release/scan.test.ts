import { describe, it, expect } from "vitest";
import { readPngJpegSize } from "../../src/release/scan.js";

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
