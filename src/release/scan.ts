import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AddonScan {
  /** Every file (relative, forward slashes), .meta files included */
  files: { rel: string; size: number; mtime: number }[];
  /** Each .meta with the resource it declares (`Name "{GUID}path"`); guid "" when it has none */
  metas: { rel: string; guid: string; namePath: string }[];
  /** Files that could not be read or stat'ed */
  unreadable: string[];
}

/**
 * Every file of an unpacked addon. Skips only .git: other dot folders such as NavMesh/.NavData ship.
 * Symlinks and junctions are not followed, so the walk stays inside the addon.
 */
export function walkAddon(dir: string): AddonScan {
  const scan: AddonScan = { files: [], metas: [], unreadable: [] };
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (r !== ".git") walk(r);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const s = statSync(join(dir, r));
        scan.files.push({ rel: r, size: s.size, mtime: s.mtimeMs });
        if (/\.meta$/i.test(r)) {
          const m = readFileSync(join(dir, r), "utf-8").match(/Name\s+"\{([0-9A-Fa-f]{16})\}([^"]*)"/);
          scan.metas.push({ rel: r, guid: m?.[1].toUpperCase() ?? "", namePath: m?.[2] ?? "" });
        }
      } catch {
        scan.unreadable.push(r);
      }
    }
  };
  walk("");
  return scan;
}

/** Format and pixel size of a PNG or JPEG from its header, or null for anything else. */
export function readPngJpegSize(buf: Buffer): { format: "png" | "jpeg"; width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  // Walk JPEG segments to the first start-of-frame (C0 to CF, except C4 DHT, C8, CC DAC)
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { format: "jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
