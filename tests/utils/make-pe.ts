/** A minimal PE32+ exe with one .rsrc section (file offset 0x200, RVA 0x1000) that holds only a version resource. */
const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

// VS_VERSIONINFO-style block: wLength, wValueLength, wType, UTF-16 key, padded value, padded children
function block(key: string, type: number, value: Buffer, valueLen: number, children: Buffer[] = []): Buffer {
  const body = Buffer.concat([pad4(Buffer.concat([Buffer.alloc(6), Buffer.from(`${key}\0`, "utf16le")])), pad4(value), ...children.map(pad4)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLen, 2);
  body.writeUInt16LE(type, 4);
  return body;
}

export function makePe(opts: { fixed: [number, number, number, number]; fileVersion?: string }): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x10000, 4);
  fixed.writeUInt32LE(((opts.fixed[0] << 16) | opts.fixed[1]) >>> 0, 8);
  fixed.writeUInt32LE(((opts.fixed[2] << 16) | opts.fixed[3]) >>> 0, 12);
  const str = (k: string, v: string) => block(k, 1, Buffer.from(`${v}\0`, "utf16le"), v.length + 1);
  const strings = opts.fileVersion
    ? [block("StringFileInfo", 1, Buffer.alloc(0), 0, [block("040904B0", 1, Buffer.alloc(0), 0, [str("CompanyName", "Bohemia"), str("FileVersion", opts.fileVersion), str("ProductVersion", opts.fileVersion)])])]
    : [];
  const blob = block("VS_VERSION_INFO", 0, fixed, 52, strings);

  const rsrc = Buffer.alloc(0x60 + blob.length);
  const dir = (at: number, id: number, off: number) => { rsrc.writeUInt16LE(1, at + 14); rsrc.writeUInt32LE(id, at + 16); rsrc.writeUInt32LE(off, at + 20); };
  dir(0, 16, 0x80000000 + 0x18); // RT_VERSION
  dir(0x18, 1, 0x80000000 + 0x30); // name
  dir(0x30, 0x409, 0x48); // language -> data entry
  rsrc.writeUInt32LE(0x1000 + 0x60, 0x48);
  rsrc.writeUInt32LE(blob.length, 0x4c);
  blob.copy(rsrc, 0x60);

  const head = Buffer.alloc(0x200);
  head.write("MZ", 0);
  head.writeUInt32LE(0x40, 0x3c);
  head.write("PE\0\0", 0x40, "latin1");
  head.writeUInt16LE(0x8664, 0x44);
  head.writeUInt16LE(1, 0x46); // sections
  head.writeUInt16LE(240, 0x54); // optional header size
  head.writeUInt16LE(0x20b, 0x58); // PE32+
  head.writeUInt32LE(0x1000, 0x58 + 112 + 16); // resource directory RVA
  head.writeUInt32LE(rsrc.length, 0x58 + 112 + 20);
  const sec = 0x58 + 240;
  head.write(".rsrc", sec, "latin1");
  head.writeUInt32LE(rsrc.length, sec + 8);
  head.writeUInt32LE(0x1000, sec + 12);
  head.writeUInt32LE(rsrc.length, sec + 16);
  head.writeUInt32LE(0x200, sec + 20);
  return Buffer.concat([head, rsrc]);
}
