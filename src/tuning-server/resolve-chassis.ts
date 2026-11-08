import {
  findBlockByPath,
  findChildBlocks,
  blockReference,
  blockId,
  blockName,
  blockClass,
  makeReader,
  collectSources,
  resolveGroup,
  resolveArray,
  stripGuid,
  type BlockRange,
  type PrefabSource,
  type ReadSources,
  type ResolvedArray,
  type ResolvedField,
  type ResolvedGroup,
} from "./config-chain.js";

const seq = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** Key sets per TyreModel class and group (T1 record, section 2). An unknown class has no groups. */
export const TYRE_MODEL_GROUPS: Record<string, Record<string, readonly string[]>> = {
  Pacejka2002: {
    top: ["NominalLoad", "NominalRadius"],
    Longitudinal: "PCX1 PDX1 PDX2 PEX1 PEX2 PEX3 PEX4 PKX1 PKX2 PKX3 PHX1 PHX2 PVX1 PVX2".split(" "),
    Lateral: "PCY1 PDY1 PDY2 PDY3 PEY1 PEY2 PEY3 PEY4 PKY1 PKY2 PKY3 PHY1 PHY2 PHY3 PVY1 PVY2 PVY3 PVY4".split(" "),
    CombinedLongitudinal: "RBX1 RBX2 RCX1 REX1 REX2 RHX1".split(" "),
    CombinedLateral: "RBY1 RBY2 RBY3 RCY1 REY1 REY2 RHY1 RVY1 RVY2 RVY3 RVY4 RVY5 RVY6".split(" "),
    // No QDZ5 in 1.9 data.
    Aligning: [
      ...seq("QBZ", 1, 10), "QCZ1", ...seq("QDZ", 1, 4), ...seq("QDZ", 6, 11),
      ...seq("QEZ", 1, 5), ...seq("QHZ", 1, 4), ...seq("QSSZ", 1, 4),
    ],
  },
  Pacejka94: {
    Longitudinal: seq("b", 0, 10),
    Lateral: seq("a", 0, 14),
    // No c15 in 1.9 data.
    Aligning: [...seq("c", 0, 14), "c16", "c17"],
  },
};

export const SUSPENSION_KEYS =
  ["SpringRate", "CompressionDamper", "RelaxationDamper", "MaxTravelUp", "MaxTravelDown", "MaxSteeringAngle"] as const;
export const TYRE_KEYS =
  ["Roughness", "LongitudinalFriction", "LateralFriction", "RollingResistance", "RollingDrag", "Tread"] as const;
export const STEERING_KEYS =
  ["SteeringRatio", "PowerSteeringFactor", "SteeringDamping", "MechanicalTrail", "ScrubRadius"] as const;
export const WHEEL_KEYS = ["Radius", "Mass", "BrakeTorque", "HandbrakeTorqueFactor", "HZDefault"] as const;
export const SWAYBAR_KEYS = ["Stiffness"] as const;
export const DIFFERENTIAL_KEYS = ["Type", "Parent", "Output0", "Output1", "Ratio", "Strength"] as const;
export const AERODYNAMICS_KEYS = ["ReferenceArea", "DragCoefficient"] as const;

const TORQUE_SHARE_NOTE = "present in 1.9 data, unverified whether read";

export interface ChassisResolveOptions extends ReadSources {
  modText: string;
  /** Addon-relative path, used to find the same-path vanilla prefab. */
  relPath: string;
}

/** A block's group of fields, with the ID the block carries in the nearest file that has it. */
export interface BlockGroup {
  id: string | null;
  fields: ResolvedGroup;
}

export interface ResolvedTyreModel {
  class: string;
  id: string | null;
  /** Path of the nearest conf reference found on a TyreModel block. */
  conf: string | null;
  groups: Record<string, ResolvedGroup>;
}

export interface ResolvedAxle {
  /** The axle's header ID, which is what identifies it; `index` is for display only. */
  id: string;
  index: number;
  torqueShare: ResolvedField & { note: string };
  suspension: BlockGroup;
  tyre: BlockGroup;
  steering: BlockGroup;
  wheel: BlockGroup;
  swaybar?: BlockGroup;
}

export interface ResolvedDifferential {
  name: string;
  /** "centre", or the ID of the axle that holds it. */
  location: string;
  type: ResolvedField;
  parent: ResolvedField;
  output0: ResolvedField;
  output1: ResolvedField;
  fields: ResolvedGroup;
}

export interface ResolvedChassis {
  tyreModel: ResolvedTyreModel | null;
  axles: ResolvedAxle[];
  differentials: ResolvedDifferential[];
  gearbox: { reverse: ResolvedField; forward: ResolvedArray };
  aerodynamics: ResolvedGroup;
}

interface Named {
  name: string;
  range: BlockRange;
}

/** Names in first-seen order, walking the sources farthest first so the base defines the order. */
function orderedUnion(perSource: string[][]): string[] {
  const out: string[] = [];
  for (const names of [...perSource].reverse()) for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

/**
 * Tyre model, axles, differentials, gearbox and aerodynamics for a vehicle.
 *
 * Matching (decision D-063): axles by header ID; Suspension, Wheel, Steering, Tyre and
 * Swaybar by property name inside the matched axle (a child often gives them a different
 * block ID); TyreModel by property name plus its header class; differentials by name.
 */
export function resolveChassis(args: ChassisResolveOptions): ResolvedChassis {
  const reader = makeReader(args);
  const sources = collectSources(reader, args.modText, args.relPath);
  const sim = (s: PrefabSource, ...path: string[]) => findBlockByPath(s.text, [...s.simPath, ...path]);
  const group = (locate: (s: PrefabSource, i: number) => BlockRange | null, keys: readonly string[], subBlock?: string) =>
    resolveGroup(reader, sources, locate, keys, subBlock);
  /** The block's ID in the nearest source that has it. */
  const idOf = (locate: (s: PrefabSource, i: number) => BlockRange | null): string | null => {
    for (let i = 0; i < sources.length; i++) {
      const r = locate(sources[i], i);
      if (r) return blockId(sources[i].text, r);
    }
    return null;
  };

  // --- TyreModel: one object beside Axles. Only sources whose class equals the nearest one are read.
  const tyreAt = (s: PrefabSource) => sim(s, "TyreModel");
  const firstTyre = sources.findIndex((s) => tyreAt(s));
  let tyreModel: ResolvedTyreModel | null = null;
  if (firstTyre !== -1) {
    const cls = blockClass(sources[firstTyre].text, tyreAt(sources[firstTyre])!);
    const same = sources.filter((s) => {
      const r = tyreAt(s);
      return r && blockClass(s.text, r) === cls;
    });
    const locate = (s: PrefabSource) => tyreAt(s);
    const confRef = same.map((s) => blockReference(s.text, tyreAt(s)!)).find((r) => r);
    const groups: Record<string, ResolvedGroup> = {};
    for (const [name, keys] of Object.entries(TYRE_MODEL_GROUPS[cls] ?? {})) {
      groups[name] = resolveGroup(reader, same, locate, keys, name === "top" ? undefined : name);
    }
    tyreModel = {
      class: cls,
      id: blockId(same[0].text, tyreAt(same[0])!),
      conf: confRef ? stripGuid(confRef) : null,
      groups,
    };
  }

  // --- Axles, matched by header ID.
  const axlesIn: { id: string; range: BlockRange }[][] = sources.map((s) => {
    const parent = sim(s, "Axles");
    if (!parent) return [];
    return findChildBlocks(s.text, parent, "Axle").flatMap((range) => {
      const id = blockId(s.text, range);
      return id ? [{ id, range }] : [];
    });
  });
  const axleRange = (id: string) => (_s: PrefabSource, i: number) => axlesIn[i].find((a) => a.id === id)?.range ?? null;
  const inAxle = (id: string, name: string) => (s: PrefabSource, i: number) => {
    const axle = axleRange(id)(s, i);
    return axle ? (findChildBlocks(s.text, axle, name)[0] ?? null) : null;
  };
  const blockGroup = (locate: (s: PrefabSource, i: number) => BlockRange | null, keys: readonly string[]): BlockGroup => ({
    id: idOf(locate),
    fields: group(locate, keys),
  });

  const axleIds = orderedUnion(axlesIn.map((list) => list.map((a) => a.id)));
  const axles: ResolvedAxle[] = axleIds.map((id, index) => {
    const swaybar = inAxle(id, "Swaybar");
    return {
      id,
      index,
      torqueShare: { ...group(axleRange(id), ["TorqueShare"]).TorqueShare, note: TORQUE_SHARE_NOTE },
      suspension: blockGroup(inAxle(id, "Suspension"), SUSPENSION_KEYS),
      tyre: blockGroup(inAxle(id, "Tyre"), TYRE_KEYS),
      steering: blockGroup(inAxle(id, "Steering"), STEERING_KEYS),
      wheel: blockGroup(inAxle(id, "Wheel"), WHEEL_KEYS),
      ...(sources.some((s, i) => swaybar(s, i)) ? { swaybar: blockGroup(swaybar, SWAYBAR_KEYS) } : {}),
    };
  });

  // --- Differentials, matched by name: the centre ones under Differentials, then each axle's own.
  const diffsIn = (list: (s: PrefabSource, i: number) => BlockRange | null): Named[][] =>
    sources.map((s, i) => {
      const parent = list(s, i);
      return parent ? findChildBlocks(s.text, parent, "Differential").map((range) => ({ name: blockName(s.text, range), range })) : [];
    });
  const differentials: ResolvedDifferential[] = [];
  const addDiffs = (location: string, perSource: Named[][]) => {
    for (const name of orderedUnion(perSource.map((l) => l.map((d) => d.name)))) {
      const locate = (_s: PrefabSource, i: number) => perSource[i].find((d) => d.name === name)?.range ?? null;
      const g = group(locate, DIFFERENTIAL_KEYS);
      differentials.push({
        name,
        location,
        type: g.Type,
        parent: g.Parent,
        output0: g.Output0,
        output1: g.Output1,
        fields: { Ratio: g.Ratio, Strength: g.Strength },
      });
    }
  };
  addDiffs("centre", diffsIn((s) => sim(s, "Differentials")));
  for (const id of axleIds) addDiffs(id, diffsIn(axleRange(id)));

  const gearbox = (s: PrefabSource) => sim(s, "Gearbox");
  return {
    tyreModel,
    axles,
    differentials,
    gearbox: {
      reverse: group(gearbox, ["Reverse"]).Reverse,
      forward: resolveArray(reader, sources, gearbox, "Forward"),
    },
    aerodynamics: group((s) => sim(s, "Aerodynamics"), AERODYNAMICS_KEYS),
  };
}
