/**
 * Arma Reforger dedicated server config (server.json).
 * Field names follow backend/DSConfigSchema.json shipped in the 1.8 game data
 * (the pre-1.0 gameHostBindAddress/gameHostBindPort/... keys are gone).
 */

export interface ServerMod {
  /** Workshop mod GUID */
  modId: string;
  name?: string;
  /** "x.y.z"; omit for latest */
  version?: string;
  required?: boolean;
}

export interface ServerConfigOptions {
  /** Server display name */
  name: string;
  /** Legacy single-mod shortcut: addon ID from .gproj */
  modName?: string;
  /** Legacy single-mod shortcut: addon GUID from .gproj */
  modId?: string;
  /** Workshop mods the server loads (clients download them) */
  mods?: ServerMod[];
  /** Scenario resource e.g. "{ECC61978EDCC2B5A}Missions/23_Campaign.conf" */
  scenarioId?: string;
  maxPlayers?: number;
  /** UDP game port (default 2001) */
  port?: number;
  /** A2S query port (default 17777) */
  a2sPort?: number;
  visible?: boolean;
  password?: string;
  passwordAdmin?: string;
  /** Identity IDs / Steam IDs of admins */
  admins?: string[];
  crossPlatform?: boolean;
  battlEye?: boolean;
  /** RCON (disabled when no password) */
  rconPassword?: string;
  /** Persistence: autosave every N minutes (0 = off) */
  autoSaveInterval?: number;
  aiLimit?: number;
}

export function generateServerConfig(opts: ServerConfigOptions): string {
  const port = opts.port ?? 2001;
  const mods: ServerMod[] = [...(opts.mods ?? [])];
  if (opts.modId) mods.push({ modId: opts.modId, name: opts.modName ?? "" });

  const gameProperties: Record<string, unknown> = {
    serverMaxViewDistance: 1600,
    networkViewDistance: 1500,
    serverMinGrassDistance: 50,
    disableThirdPerson: false,
    fastValidation: true,
    battlEye: opts.battlEye ?? false,
  };
  if (opts.autoSaveInterval !== undefined) {
    gameProperties.persistence = { autoSaveInterval: opts.autoSaveInterval, loadSessionSave: false };
  }

  const config: Record<string, unknown> = {
    bindAddress: "0.0.0.0",
    bindPort: port,
    publicAddress: "",
    publicPort: port,
    a2s: { address: "0.0.0.0", port: opts.a2sPort ?? 17777 },
    ...(opts.rconPassword
      ? { rcon: { address: "0.0.0.0", port: 19999, password: opts.rconPassword, permission: "admin", maxClients: 4 } }
      : {}),
    game: {
      name: opts.name,
      password: opts.password ?? "",
      passwordAdmin: opts.passwordAdmin ?? "",
      admins: opts.admins ?? [],
      scenarioId: opts.scenarioId ?? "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
      maxPlayers: opts.maxPlayers ?? 32,
      visible: opts.visible ?? false,
      crossPlatform: opts.crossPlatform ?? false,
      gameProperties,
      mods,
    },
    operating: {
      lobbyPlayerSynchronise: true,
      ...(opts.aiLimit !== undefined ? { aiLimit: opts.aiLimit } : {}),
    },
  };

  return JSON.stringify(config, null, 2);
}

/** Minimal JSON-Schema check (type / required / properties / additionalProperties / items / enum / min / max). */
export function validateAgainstSchema(value: unknown, schema: Record<string, any>, path = "$"): string[] {
  const errs: string[] = [];
  const types = ([] as string[]).concat(schema.type ?? []);
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    errs.push(`${path}: expected ${types.join("|")}, got ${actual}`);
    return errs;
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errs.push(`${path}: ${schema.patternDesc ?? `must match ${schema.pattern}`}`);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: Record<string, any>) => validateAgainstSchema(value, s, path).length === 0)) {
    errs.push(`${path}: ${schema.anyOf.map((s: Record<string, any>) => s.patternDesc ?? JSON.stringify(s)).join(" OR ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (actual === "object" && value) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validateAgainstSchema(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unknown key`);
      else if (typeof schema.additionalProperties === "object") errs.push(...validateAgainstSchema(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  if (actual === "array" && schema.items) (value as unknown[]).forEach((v, i) => errs.push(...validateAgainstSchema(v, schema.items, `${path}[${i}]`)));
  return errs;
}
