import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePakIndex } from "../../src/pak/reader.js";
import { buildTestPak } from "./test-pak.js";

// ── Tests ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "enfusion-mcp-pak-test-" + process.pid);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parsePakIndex", () => {
  it("parses a pak with uncompressed files", () => {
    const pakBuf = buildTestPak([
      { path: "Scripts/hello.c", content: "void main() {}", compress: false },
      { path: "Prefabs/box.et", content: 'GenericEntity { ID "box" }', compress: false },
    ]);
    const pakPath = join(TEST_DIR, "test_uncompressed.pak");
    writeFileSync(pakPath, pakBuf);

    const index = parsePakIndex(pakPath);

    expect(index.root.kind).toBe("dir");
    expect(index.root.children.size).toBe(2); // Scripts, Prefabs

    const scripts = index.root.children.get("Scripts");
    expect(scripts).toBeDefined();
    expect(scripts!.kind).toBe("dir");

    const hello = (scripts as any).children.get("hello.c");
    expect(hello).toBeDefined();
    expect(hello.kind).toBe("file");
    expect(hello.compressed).toBe(false);
    expect(hello.decompressedLen).toBe(Buffer.from("void main() {}").length);
  });

  it("parses a pak with compressed files", () => {
    const content = "This is a test file with some content that should compress well. ".repeat(10);
    const pakBuf = buildTestPak([
      { path: "data/test.txt", content, compress: true },
    ]);
    const pakPath = join(TEST_DIR, "test_compressed.pak");
    writeFileSync(pakPath, pakBuf);

    const index = parsePakIndex(pakPath);

    const data = index.root.children.get("data");
    expect(data).toBeDefined();
    expect(data!.kind).toBe("dir");

    const testFile = (data as any).children.get("test.txt");
    expect(testFile).toBeDefined();
    expect(testFile.kind).toBe("file");
    expect(testFile.compressed).toBe(true);
    expect(testFile.decompressedLen).toBe(Buffer.from(content).length);
    expect(testFile.compressedLen).toBeLessThan(testFile.decompressedLen);
  });

  it("parses nested directory structures", () => {
    const pakBuf = buildTestPak([
      { path: "a/b/c/deep.c", content: "deep", compress: false },
      { path: "a/b/sibling.c", content: "sibling", compress: false },
      { path: "a/top.c", content: "top", compress: false },
    ]);
    const pakPath = join(TEST_DIR, "test_nested.pak");
    writeFileSync(pakPath, pakBuf);

    const index = parsePakIndex(pakPath);

    const a = index.root.children.get("a") as any;
    expect(a.kind).toBe("dir");
    expect(a.children.size).toBe(2); // b, top.c

    const b = a.children.get("b") as any;
    expect(b.kind).toBe("dir");
    expect(b.children.size).toBe(2); // c, sibling.c

    const c = b.children.get("c") as any;
    expect(c.kind).toBe("dir");
    expect(c.children.get("deep.c")).toBeDefined();
  });

  it("throws on invalid magic", () => {
    const bad = Buffer.alloc(12);
    bad.write("NOPE", 0, 4, "ascii");
    const pakPath = join(TEST_DIR, "bad_magic.pak");
    writeFileSync(pakPath, bad);

    expect(() => parsePakIndex(pakPath)).toThrow("Not a PAK file");
  });

  it("throws on truncated file", () => {
    const pakPath = join(TEST_DIR, "truncated.pak");
    writeFileSync(pakPath, Buffer.alloc(4));

    expect(() => parsePakIndex(pakPath)).toThrow();
  });
});

describe("PAK reader bounds checks", () => {
  it("should reject chunk with size exceeding file", () => {
    // Create a minimal PAK with a chunk whose size field exceeds the file
    const buf = Buffer.alloc(20);
    buf.writeUInt32BE(0x464f524d, 0); // FORM
    buf.writeUInt32BE(8, 4);           // FORM size
    buf.writeUInt32BE(0x50414331, 8);  // PAC1
    // DATA chunk at offset 12 with absurd size
    buf.writeUInt32BE(0x44415441, 12); // DATA
    buf.writeUInt32BE(0xffff0000, 16); // chunk size exceeds file

    const pakPath = join(tmpdir(), `test-oversize-${process.pid}.pak`);
    writeFileSync(pakPath, buf);
    try {
      expect(() => parsePakIndex(pakPath)).toThrow();
    } finally {
      rmSync(pakPath, { force: true });
    }
  });
});
