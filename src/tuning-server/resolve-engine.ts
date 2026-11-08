import { ENGINE_FIELD_KEYS, type EngineFields } from "./engine-conf.js";
import {
  makeReader,
  collectSources,
  resolveGroup,
  findBlockByPath,
  type ReadSources,
  type ResolvedField,
} from "./config-chain.js";

export type ResolvedEngine = Record<keyof EngineFields, ResolvedField>;

/** Where the base data comes from (addon root, extracted folder or paks) is in `ReadSources`. */
export interface ResolveOptions extends ReadSources {
  modText: string;
  relPath: string;
}

/**
 * Fill the engine fields for a vehicle. A prefab stores only what differs from its
 * parent, so a field set back to its default vanishes from the file and is recovered
 * from the parent chain, the engine .conf chain or the component template, nearest first.
 */
export function resolveEngineFields(args: ResolveOptions): ResolvedEngine {
  const reader = makeReader(args);
  const sources = collectSources(reader, args.modText, args.relPath);
  return resolveGroup(
    reader,
    sources,
    (s) => findBlockByPath(s.text, [...s.simPath, "Engine"]),
    ENGINE_FIELD_KEYS
  ) as ResolvedEngine;
}
