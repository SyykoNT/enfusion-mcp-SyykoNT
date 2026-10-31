import { deflateSync } from "node:zlib";

/**
 * Build a minimal synthetic .pak file in memory.
 *
 * Layout:
 *   FORM header (12 bytes)
 *   HEAD chunk  (8 + 0x1c bytes)
 *   DATA chunk  (8 + data payload bytes)
 *   FILE chunk  (8 + file tree bytes)
 */
export function buildTestPak(files: Array<{ path: string; content: string; compress: boolean }>): Buffer {
  // ── Build DATA payload and FILE tree simultaneously ────────────────────
  const dataChunks: Buffer[] = [];
  // FILE-chunk offsets are absolute positions in the .pak: 56 is where this layout's DATA payload starts
  let dataOffset = 56;

  interface TreeFile {
    name: string;
    offset: number;
    compressedLen: number;
    decompressedLen: number;
    compressed: boolean;
  }
  interface TreeDir {
    name: string;
    children: Map<string, TreeDir | TreeFile>;
  }

  const root: TreeDir = { name: "", children: new Map() };

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf-8");
    let stored: Buffer;
    if (file.compress) {
      stored = deflateSync(raw);
    } else {
      stored = raw;
    }

    // Insert into tree
    const parts = file.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child || !("children" in child)) {
        child = { name: part, children: new Map() };
        dir.children.set(part, child);
      }
      dir = child as TreeDir;
    }

    dir.children.set(fileName, {
      name: fileName,
      offset: dataOffset,
      compressedLen: stored.length,
      decompressedLen: raw.length,
      compressed: file.compress,
    });

    dataChunks.push(stored);
    dataOffset += stored.length;
  }

  // ── Serialize FILE tree ────────────────────────────────────────────────
  function serializeEntry(entry: TreeDir | TreeFile): Buffer {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const parts: Buffer[] = [];

    const header = Buffer.alloc(2);
    if ("children" in entry) {
      // Directory
      header.writeUInt8(0, 0); // kind = folder
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);

      const countBuf = Buffer.alloc(4);
      countBuf.writeUInt32LE(entry.children.size, 0);
      parts.push(countBuf);

      for (const child of entry.children.values()) {
        parts.push(serializeEntry(child));
      }
    } else {
      // File
      header.writeUInt8(1, 0); // kind = file
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);

      const meta = Buffer.alloc(20); // 4+4+4+4+2+1+1 = 20 bytes
      meta.writeUInt32LE(entry.offset, 0);
      meta.writeUInt32LE(entry.compressedLen, 4);
      meta.writeUInt32LE(entry.decompressedLen, 8);
      meta.writeUInt32LE(0, 12); // unknown
      meta.writeUInt16LE(0, 16); // unk2
      meta.writeUInt8(entry.compressed ? 1 : 0, 18);
      meta.writeUInt8(entry.compressed ? 6 : 0, 19); // compression_level
      parts.push(meta);

      const tsBuf = Buffer.alloc(4);
      tsBuf.writeUInt32LE(0, 0); // timestamp
      parts.push(tsBuf);
    }

    return Buffer.concat(parts);
  }

  const fileTreeBuf = serializeEntry(root);
  const dataPayload = Buffer.concat(dataChunks);

  // ── HEAD chunk (minimal: 0x1c bytes of zeros) ──────────────────────────
  const headLen = 0x1c;
  const headPayload = Buffer.alloc(headLen);

  // ── Assemble chunks ────────────────────────────────────────────────────
  const totalPayload =
    4 + // "PAC1"
    8 + headLen +
    8 + dataPayload.length +
    8 + fileTreeBuf.length;

  const buf = Buffer.alloc(8 + totalPayload);
  let pos = 0;

  // FORM header
  buf.write("FORM", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(totalPayload, pos); pos += 4;
  buf.write("PAC1", pos, 4, "ascii"); pos += 4;

  // HEAD chunk
  buf.write("HEAD", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(headLen, pos); pos += 4;
  headPayload.copy(buf, pos); pos += headLen;

  // DATA chunk
  buf.write("DATA", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(dataPayload.length, pos); pos += 4;
  dataPayload.copy(buf, pos); pos += dataPayload.length;

  // FILE chunk
  buf.write("FILE", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(fileTreeBuf.length, pos); pos += 4;
  fileTreeBuf.copy(buf, pos);

  return buf;
}

/** One resourceDatabase.rdb record the way Arma Reforger 1.8 stores it. */
export function record(path: string, guidHex: string): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(path.length + 1);
  return Buffer.concat([len, Buffer.from(path + "\0", "latin1"), Buffer.from([6, 0, 0, 0, 0, 0]), Buffer.from(guidHex, "hex").reverse(), Buffer.alloc(8)]);
}

/** A whole resourceDatabase.rdb from path to GUID pairs. */
export function buildRdb(entries: Record<string, string>): Buffer {
  return Buffer.concat([Buffer.from("FORM\0\0\0\0RDBC"), ...Object.entries(entries).map(([path, guid]) => record(path, guid))]);
}
