// src/tuning-server/resolve-engine.ts
import { ENGINE_FIELD_KEYS, parseEngineConfPartial, type EngineFields } from "./engine-conf.js";
import { findEngineBlock, readEngineFieldsFromBlock, findParentReference } from "./et-engine-block.js";
import { makeReader, stripGuid, type ReadSources } from "./config-chain.js";

export type FieldSource = "overridden" | "inherited" | "unresolved";

export interface ResolvedField {
  value: number | null;
  source: FieldSource;
}

export type ResolvedEngine = Record<keyof EngineFields, ResolvedField>;

/** Where the base data comes from (addon root, extracted folder or paks) is in `ReadSources`. */
export interface ResolveOptions extends ReadSources {
  modText: string;
  relPath: string;
}

const MAX_CHAIN_DEPTH = 16;

/**
 * Fill all 9 engine fields for a vehicle by walking its inheritance chain.
 *
 *   1. values in the prefab's own Engine block        -> "overridden"
 *   2. values from any ancestor prefab, nearest first -> "inherited"
 *   3. the .conf an Engine block references           -> "inherited"
 *   4. nothing found                                  -> "unresolved"
 *
 * A prefab stores only what differs from its parent, so a field the user set
 * back to its default vanishes from the file entirely and must be recovered
 * from further up. That is what makes this walk necessary rather than a nicety.
 */
export function resolveEngineFields(args: ResolveOptions): ResolvedEngine {
  const reader = makeReader(args);
  const overridden: Partial<EngineFields> = {};
  const inherited: Partial<EngineFields> = {};

  // `reader.copies` returns every copy of a referenced path, mod first then vanilla. A mod prefab
  // that shadows a vanilla one of the same path (RoadForger's M151A2.et does) usually
  // adds components without redefining the engine, so reading only the mod copy
  // loses everything the vanilla file at that path defines.
  const confFromRef = (ref: string | undefined, into: Partial<EngineFields>): void => {
    if (!ref) return;
    const text = reader.ref(ref);
    if (text) {
      // Nearest definition wins: never overwrite something already resolved.
      const vals = parseEngineConfPartial(text);
      for (const k of ENGINE_FIELD_KEYS) if (into[k] === undefined && vals[k] !== undefined) into[k] = vals[k];
    }
  };

  const modLoc = findEngineBlock(args.modText);
  if (modLoc) {
    Object.assign(overridden, readEngineFieldsFromBlock(args.modText, modLoc));
    confFromRef(modLoc.inheritance, inherited);
  }

  // Walk up the parent chain, taking each field from the nearest ancestor that
  // defines it. Depth-capped and cycle-guarded so a malformed prefab graph
  // cannot hang the request.
  let text: string | null = args.modText;
  const seen = new Set<string>([args.relPath]);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && text; depth++) {
    const parentRef: string | null = findParentReference(text);
    if (!parentRef) break;
    const parentRel = stripGuid(parentRef);
    if (seen.has(parentRel)) break;
    seen.add(parentRel);

    const parentTexts: string[] = reader.copies(parentRef);
    if (parentTexts.length === 0) break;

    for (const parentText of parentTexts) {
      const loc = findEngineBlock(parentText);
      if (!loc) continue;
      const vals = readEngineFieldsFromBlock(parentText, loc);
      for (const k of ENGINE_FIELD_KEYS) if (inherited[k] === undefined && vals[k] !== undefined) inherited[k] = vals[k];
      confFromRef(loc.inheritance, inherited);
    }
    // Continue up through the mod's copy: it is the authoritative parent chain.
    text = parentTexts[0];
  }

  // Last resort: the same path in the vanilla data (extracted folder or paks). A mod prefab that
  // shadows a vanilla one of the same name inherits its values without naming it
  // as a parent, so this is not reachable by walking the chain above.
  if (ENGINE_FIELD_KEYS.some((k) => overridden[k] === undefined && inherited[k] === undefined)) {
    const vanillaText = reader.base(args.relPath);
    if (vanillaText) {
      const vLoc = findEngineBlock(vanillaText);
      if (vLoc) {
        const vInline = readEngineFieldsFromBlock(vanillaText, vLoc);
        // The block's own inline fields win over the conf it references.
        for (const k of ENGINE_FIELD_KEYS) if (inherited[k] === undefined && vInline[k] !== undefined) inherited[k] = vInline[k];
        confFromRef(vLoc.inheritance, inherited);
      }
    }
  }

  const out = {} as ResolvedEngine;
  for (const key of ENGINE_FIELD_KEYS) {
    if (overridden[key] !== undefined) {
      out[key] = { value: overridden[key]!, source: "overridden" };
    } else if (inherited[key] !== undefined) {
      out[key] = { value: inherited[key]!, source: "inherited" };
    } else {
      out[key] = { value: null, source: "unresolved" };
    }
  }
  return out;
}
