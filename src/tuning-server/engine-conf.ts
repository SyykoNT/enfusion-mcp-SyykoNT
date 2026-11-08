// The Engine keys of Reforger 1.9 vehicle data (T1 record 2026-11-08_TUNING-1.9_schema, section 2).
// Inertia and Friction are kept because some 1.9 vanilla files still carry them; whether 1.9
// reads them is unverified (TUNING-1.9 T6 checks it live).
export interface EngineFields {
  MaxPower: number;
  MaxTorque: number;
  RpmMaxPower: number;
  RpmMaxTorque: number;
  Steepness: number;
  RpmIdle: number;
  RpmRedline: number;
  RpmMax: number;
  Inertia: number;
  InertiaCoupled: number;
  Friction: number;
}

export const ENGINE_FIELD_KEYS: (keyof EngineFields)[] = [
  "MaxPower",
  "MaxTorque",
  "RpmMaxPower",
  "RpmMaxTorque",
  "Steepness",
  "RpmIdle",
  "RpmRedline",
  "RpmMax",
  "Inertia",
  "InertiaCoupled",
  "Friction",
];
