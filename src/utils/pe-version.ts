import { closeSync, openSync, readSync } from "node:fs";

/**
 * File version ("1.9.0.37") from the version resource of a Windows exe: the "FileVersion" string, else VS_FIXEDFILEINFO. Undefined for a missing file, a non-PE file
 * (the Linux server) or anything unreadable. Reads the headers and the few resource tables on the way, not the whole file.
 */
export function peFileVersion(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const f = fd;
    const read = (off: number, len: number): Buffer => {
      const b = Buffer.alloc(len);
      if (readSync(f, b, 0, len, off) < len) throw new Error("short read");
      return b;
    };
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return undefined;
    const pe = dos.readUInt32LE(0x3c);
    const coff = read(pe, 24);
    if (coff.readUInt32LE(0) !== 0x4550) return undefined;
    const sections = coff.readUInt16LE(6);
    const optSize = coff.readUInt16LE(20);
    if (!sections || sections > 96 || optSize < 112 || optSize > 1024) return undefined;
    const opt = read(pe + 24, optSize);
    // PE32 keeps its data directories at 96, PE32+ at 112; entry 2 is the resource table
    const dirAt = opt.readUInt16LE(0) === 0x20b ? 112 : 96;
    const rsrcRva = opt.readUInt32LE(dirAt + 16);
    if (!rsrcRva) return undefined;
    const table = read(pe + 24 + optSize, 40 * sections);
    const toOffset = (rva: number): number => {
      for (let i = 0; i < sections; i++) {
        const virtualSize = table.readUInt32LE(i * 40 + 8), va = table.readUInt32LE(i * 40 + 12), rawSize = table.readUInt32LE(i * 40 + 16), raw = table.readUInt32LE(i * 40 + 20);
        if (rva >= va && rva < va + Math.max(virtualSize, rawSize)) return raw + (rva - va);
      }
      throw new Error("RVA outside every section");
    };
    const base = toOffset(rsrcRva);
    // entry: id/name then offset; the high bit of the offset marks a subdirectory. Returns the offset field of the entry with that id, or of the first entry.
    const entry = (dirOff: number, id?: number): number => {
      const head = read(base + dirOff, 16);
      const named = head.readUInt16LE(12), ids = head.readUInt16LE(14);
      if (named + ids === 0 || named + ids > 256) throw new Error("bad resource directory");
      const entries = read(base + dirOff + 16, (named + ids) * 8);
      for (let i = 0; i < named + ids; i++) {
        if (id === undefined || (i >= named && entries.readUInt32LE(i * 8) === id)) return entries.readUInt32LE(i * 8 + 4);
      }
      throw new Error("resource type not found");
    };
    const type = entry(0, 16) & 0x7fffffff; // RT_VERSION, then its first name, then its first language
    const lang = entry(type) & 0x7fffffff;
    const data = read(base + (entry(lang) & 0x7fffffff), 8);
    const info = read(toOffset(data.readUInt32LE(0)), Math.min(Math.max(data.readUInt32LE(4), 56), 65536));
    // VS_VERSIONINFO: 6-byte header, 32-byte "VS_VERSION_INFO", 2 bytes padding, then VS_FIXEDFILEINFO
    if (info.readUInt32LE(40) !== 0xfeef04bd) return undefined;
    // The game exes carry 1.9.0.37 only in the "FileVersion" string (what Explorer shows); their numeric fields say 1.9.0.0.
    // Every block starts 4-aligned with its key at +6, so decoding the whole blob as UTF-16 keeps the key and its value in step.
    const text = info.subarray(0, info.length & ~1).toString("utf16le").match(/FileVersion\0+(\d+\.\d+\.\d+\.\d+)\0/);
    if (text) return text[1];
    const ms = info.readUInt32LE(48), ls = info.readUInt32LE(52);
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
