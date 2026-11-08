import { ENGINE_FIELD_KEYS } from "./engine-conf.js";
import { countUnquotedBraces } from "./et-engine-block.js";
import { findBlockByPath, findChildBlocks, blockId, blockName, blockClass, type BlockRange } from "./config-chain.js";
import {
  TYRE_MODEL_GROUPS,
  SUSPENSION_KEYS,
  TYRE_KEYS,
  STEERING_KEYS,
  WHEEL_KEYS,
  SWAYBAR_KEYS,
  DIFFERENTIAL_KEYS,
} from "./resolve-chassis.js";

/**
 * The writing half of the tuning server: numeric values go into blocks that already
 * exist in the vehicle's own .et, matched as the reader matches them (decision D-063):
 * axles by header ID, the parts inside an axle and TyreModel by property name,
 * differentials by name. Nothing is created, no .conf is touched, and every byte
 * outside the changed lines is kept.
 */

const SIM_PATH = ["components", "VehicleWheeledSimulation", "Simulation"];
const PARTS = ["engine", "tyreModel", "axles", "differentials"];

const AXLE_PARTS: Record<string, { block: string; keys: readonly string[] }> = {
  suspension: { block: "Suspension", keys: SUSPENSION_KEYS },
  tyre: { block: "Tyre", keys: TYRE_KEYS },
  steering: { block: "Steering", keys: STEERING_KEYS },
  wheel: { block: "Wheel", keys: WHEEL_KEYS },
  swaybar: { block: "Swaybar", keys: SWAYBAR_KEYS },
};

// String and enum fields stay read-only (plan TUNING-1.9, out of scope).
const DIFF_TEXT_KEYS: readonly string[] = ["Type", "Parent", "Output0", "Output1"];
const DIFF_NUMERIC_KEYS = DIFFERENTIAL_KEYS.filter((k) => !DIFF_TEXT_KEYS.includes(k));

const HEX_ID = /^[0-9A-Fa-f]+$/;

/**
 * A number in plain decimal. Vanilla data never uses exponents (T1 record), so
 * `1e-7` becomes `0.0000001` and `1e21` becomes `1000000000000000000000`.
 * The digits are the shortest round-trip form, only the decimal point moves.
 */
export function formatNumber(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", expText] = m;
  const exp = Number(expText);
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${int}${frac}`;
  return `${sign}${int}${frac}${"0".repeat(exp - frac.length)}`;
}

interface BlockWrite {
  label: string;
  range: BlockRange;
  /** Values in the order of the block's key set, so inserts are deterministic. */
  values: [string, number][];
}

export type WritePlan =
  | { ok: true; text: string; written: string[] }
  | { ok: false; status: 400 | 409; message: string; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a POST `changes` object against the vehicle .et text and return the new
 * text, or why nothing may be written: 400 for a bad request (unknown part, group or
 * key, a non-finite or non-number value), 409 when a target block is not in this .et.
 */
export function planBlockWrites(text: string, changes: unknown): WritePlan {
  const errors: string[] = [];
  const conflicts: string[] = [];
  const writes: BlockWrite[] = [];
  if (!isObj(changes)) return bad([`"changes" must be an object with any of: ${PARTS.join(", ")}`]);

  const lines = text.split(/\r?\n/);
  const sim = findBlockByPath(text, SIM_PATH);
  const child = (parent: BlockRange | null | undefined, name: string): BlockRange[] =>
    parent ? findChildBlocks(text, parent, name) : [];
  const sameId = (range: BlockRange, id: string) => blockId(text, range)?.toUpperCase() === id.toUpperCase();
  const axleBlocks = child(child(sim, "Axles")[0], "Axle");

  /** Check one group of values and queue it for its block; `keys` null means the block is missing so its key set is unknown. */
  const add = (label: string, range: BlockRange | null | undefined, keys: readonly string[] | null, values: unknown) => {
    if (!isObj(values)) {
      errors.push(`${label}: values must be an object of key: number`);
      return;
    }
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    for (const [k, v] of entries) {
      if (keys && !keys.includes(k)) {
        errors.push(`${label}: ${JSON.stringify(k)} is not a writable key here (allowed: ${keys.join(", ")})`);
      } else if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`${label}.${k}: value must be a finite number`);
      }
    }
    if (!range || !keys) {
      conflicts.push(`${label} is not in this .et`);
      return;
    }
    const header = lines[range.openLine];
    if (/\+\s*\{\s*$/.test(header)) {
      conflicts.push(`${label} is an append array (+{), not a block to write into`);
      return;
    }
    // Inserts go on a line of their own before the closing brace, so it must stand alone.
    if (range.closeLine <= range.openLine || lines[range.closeLine].trim() !== "}") {
      conflicts.push(`${label} is not laid out as Workbench saves it (closing brace on its own line)`);
      return;
    }
    // Only used when no error was found, so every value here is a finite number.
    writes.push({ label, range, values: keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, values[k] as number]) });
  };

  for (const part of Object.keys(changes)) {
    if (!PARTS.includes(part)) errors.push(`unknown part ${JSON.stringify(part)} in changes (allowed: ${PARTS.join(", ")})`);
  }

  if (Object.hasOwn(changes, "engine")) add("Engine", child(sim, "Engine")[0], ENGINE_FIELD_KEYS, changes.engine);

  if (Object.hasOwn(changes, "tyreModel")) {
    const tm = changes.tyreModel;
    // TyreModel is the single object beside Axles; its class comes from its own header in this .et.
    const range = child(sim, "TyreModel")[0];
    const cls = range ? blockClass(text, range) : "";
    const groups = Object.hasOwn(TYRE_MODEL_GROUPS, cls) ? TYRE_MODEL_GROUPS[cls] : {};
    if (!isObj(tm)) errors.push("tyreModel must be an object of groups");
    else {
      for (const [group, values] of Object.entries(tm)) {
        const label = group === "top" ? "TyreModel" : `TyreModel ${group}`;
        if (!range) {
          add(label, null, null, values);
        } else if (!Object.hasOwn(groups, group)) {
          errors.push(`TyreModel class ${cls} has no group ${JSON.stringify(group)} (groups: ${Object.keys(groups).join(", ") || "none"})`);
        } else {
          add(label, group === "top" ? range : child(range, group)[0], groups[group], values);
        }
      }
    }
  }

  if (Object.hasOwn(changes, "axles")) {
    const seen = new Set<string>();
    if (!Array.isArray(changes.axles)) errors.push("axles must be an array");
    else
      changes.axles.forEach((entry: unknown, i: number) => {
        if (!isObj(entry) || typeof entry.axle !== "string" || !HEX_ID.test(entry.axle)) {
          errors.push(`axles[${i}].axle must be the axle's ID (hex digits, no braces)`);
          return;
        }
        const id = entry.axle;
        if (seen.has(id.toUpperCase())) {
          errors.push(`axle ${id} is listed twice`);
          return;
        }
        seen.add(id.toUpperCase());
        const axle = axleBlocks.find((r) => sameId(r, id));
        for (const [part, values] of Object.entries(entry)) {
          if (part === "axle") continue;
          if (!Object.hasOwn(AXLE_PARTS, part)) {
            errors.push(`axle ${id}: unknown part ${JSON.stringify(part)} (allowed: ${Object.keys(AXLE_PARTS).join(", ")})`);
            continue;
          }
          const { block, keys } = AXLE_PARTS[part];
          add(`Axle ${id} ${block}`, child(axle, block)[0], keys, values);
        }
      });
  }

  if (Object.hasOwn(changes, "differentials")) {
    const seen = new Set<string>();
    const centre = child(child(sim, "Differentials")[0], "Differential");
    if (!Array.isArray(changes.differentials)) errors.push("differentials must be an array");
    else
      changes.differentials.forEach((entry: unknown, i: number) => {
        if (!isObj(entry) || typeof entry.name !== "string" || entry.name === "") {
          errors.push(`differentials[${i}].name must be the differential's name`);
          return;
        }
        if (entry.axle !== undefined && (typeof entry.axle !== "string" || !HEX_ID.test(entry.axle))) {
          errors.push(`differentials[${i}].axle must be an axle ID (hex digits, no braces), or omitted for a centre differential`);
          return;
        }
        for (const k of Object.keys(entry)) {
          if (!["name", "axle", "fields"].includes(k)) errors.push(`differentials[${i}]: unknown property ${JSON.stringify(k)} (allowed: name, axle, fields)`);
        }
        const axleId = entry.axle as string | undefined;
        const key = `${axleId?.toUpperCase() ?? ""}/${entry.name}`;
        if (seen.has(key)) {
          errors.push(`differential ${entry.name} is listed twice`);
          return;
        }
        seen.add(key);
        const list = axleId === undefined ? centre : child(axleBlocks.find((r) => sameId(r, axleId)), "Differential");
        const label = `Differential ${entry.name}${axleId === undefined ? "" : ` in axle ${axleId}`}`;
        add(label, list.find((r) => blockName(text, r) === entry.name), DIFF_NUMERIC_KEYS, entry.fields);
      });
  }

  if (errors.length > 0) return bad(errors);
  if (conflicts.length > 0) {
    return {
      ok: false,
      status: 409,
      errors: conflicts,
      message: `${conflicts.join("; ")}. Add the override in Workbench first; this tool never creates blocks. Nothing was written.`,
    };
  }
  if (writes.length === 0) return bad(["changes holds no values"]);
  return {
    ok: true,
    text: applyWrites(text, writes),
    written: writes.flatMap((w) => w.values.map(([k]) => `${w.label}.${k}`)),
  };
}

function bad(errors: string[]): WritePlan {
  return { ok: false, status: 400, errors, message: `${errors.join("; ")}. Nothing was written.` };
}

/**
 * Apply each write to its own block. Every range comes from the unchanged text, so the
 * blocks are written bottom-up (latest closing line first): an insert then only shifts
 * lines below every block still to be written. Each line keeps its own line ending.
 */
function applyWrites(text: string, writes: BlockWrite[]): string {
  const lines = text.split(/(?<=\n)/);
  const body = (i: number) => lines[i].replace(/\r?\n$/, "");
  const ending = (i: number) => lines[i].slice(body(i).length);

  for (const w of [...writes].sort((a, b) => b.range.closeLine - a.range.closeLine)) {
    const want = new Map(w.values);
    const remaining = new Map(w.values);
    // Replace keys already at the block's top level (every copy, so a key is never left twice).
    let depth = 0;
    for (let i = w.range.openLine + 1; i < w.range.closeLine; i++) {
      const line = body(i);
      const m = depth === 0 ? /^(\s*)([A-Za-z][A-Za-z0-9_]*)\s+[^{}]*$/.exec(line) : null;
      if (m && want.has(m[2])) {
        lines[i] = `${m[1]}${m[2]} ${formatNumber(want.get(m[2])!)}${ending(i)}`;
        remaining.delete(m[2]);
      }
      depth += countUnquotedBraces(line);
    }
    if (remaining.size === 0) continue;

    // Insert the rest before the closing line, indented like the block's first line
    // (or one space deeper than the header: these files indent one space per level).
    const first = lines.slice(w.range.openLine + 1, w.range.closeLine).find((l) => l.trim() !== "");
    const indent = /^[ \t]*/.exec(first ?? `${/^[ \t]*/.exec(body(w.range.openLine))![0]} `)![0];
    const eol = ending(w.range.closeLine - 1);
    lines.splice(w.range.closeLine, 0, ...[...remaining].map(([k, v]) => `${indent}${k} ${formatNumber(v)}${eol}`));
  }
  return lines.join("");
}
