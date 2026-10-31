import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Enum name to its members (name to value), in source order. */
export type LobbyEnums = Map<string, Map<string, number>>;

const ENUM = /\b(modded\s+)?enum\s+(\w+)\s*(?::\s*\w+\s*)?\{([^}]*)\}/g;

/**
 * Read every enum in `<root>/Scripts/Game/**\/*.c` of each root (COALITION-Lobby, CRF), so roles
 * added upstream show up without a fork release. A `modded enum` appends its members to the
 * base enum of the same name (CRF mods COA_EGearRole and COA_EGamemode this way).
 */
export function loadLobbyEnums(roots: string[]): LobbyEnums {
  const found: { modded: boolean; name: string; body: string }[] = [];
  for (const root of roots) {
    const dir = join(root, "Scripts", "Game");
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".c")) continue;
      const text = readFileSync(join(dir, rel), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const m of text.matchAll(ENUM)) found.push({ modded: !!m[1], name: m[2], body: m[3] });
    }
  }

  const enums: LobbyEnums = new Map();
  // Bases first, so a modded enum read before its base still continues the base's numbering
  for (const e of [...found.filter((f) => !f.modded), ...found.filter((f) => f.modded)]) {
    const members = enums.get(e.name) ?? new Map<string, number>();
    enums.set(e.name, members);
    let next = members.size ? Math.max(...members.values()) + 1 : 0;
    for (const part of e.body.split(",")) {
      const [name, expr] = part.split("=").map((s) => s.trim());
      if (!/^\w+$/.test(name ?? "")) continue;
      // shortcut: only literal values (dec or hex); an expression such as `1 << 3` counts on from the previous member
      const value = expr !== undefined && Number.isFinite(Number(expr)) ? Number(expr) : next;
      members.set(name, value);
      next = value + 1;
    }
  }
  return enums;
}

/** The member with value 0: what an unset enum field in a .conf means. */
export function enumDefault(enums: LobbyEnums, name: string): string | undefined {
  for (const [member, value] of enums.get(name) ?? []) if (value === 0) return member;
  return undefined;
}
