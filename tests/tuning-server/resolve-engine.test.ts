import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEngineFields } from "../../src/tuning-server/resolve-engine.js";
import { ENGINE_FIELD_KEYS } from "../../src/tuning-server/engine-conf.js";

const VANILLA = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vanilla");
const P = "Prefabs/Vehicles/";
const CFG = `${P}Core/Configs/Engines/`;
const MOD = `${P}Wheeled/Mod/Mod.et`;

const engine = (fields: string) =>
  ` components {\n  VehicleWheeledSimulation "{731B26FCA2F19855}" {\n   Simulation Wheeled "{4D8B26DEA5F25978}" {\n    Engine Engine Engine {\n${fields}    }\n   }\n  }\n }\n`;
const leaf = (parent: string, body = "") => `Vehicle : "{ABCD0000AAAA0001}${P}${parent}" {\n${body}}\n`;

describe("resolveEngineFields", () => {
  const resolve = (modText: string, relPath = MOD) => resolveEngineFields({ modText, relPath, extractedPath: VANILLA });

  it("returns the 1.9 key set: RpmRedline and InertiaCoupled added, Inertia and Friction kept", () => {
    expect(ENGINE_FIELD_KEYS).toEqual([
      "MaxPower", "MaxTorque", "RpmMaxPower", "RpmMaxTorque", "Steepness", "RpmIdle",
      "RpmRedline", "RpmMax", "Inertia", "InertiaCoupled", "Friction",
    ]);
    expect(Object.keys(resolve(leaf("Core/Wheeled_Base.et")))).toEqual(ENGINE_FIELD_KEYS);
  });

  it("marks an inline value own, conf and parent values inherited, and component defaults template", () => {
    const r = resolve(leaf("Wheeled/Fix/Fix.et", engine("     MaxPower 75\n")));
    expect(r.MaxPower).toEqual({ value: 75, source: "own", file: MOD });
    expect(r.MaxTorque).toEqual({ value: 190, source: "inherited", file: `${CFG}Engine_Fix.conf` });
    expect(r.InertiaCoupled.value).toBe(0.3);
    // Two confs up, and nearer than the template's own default (6000).
    expect(r.RpmRedline).toEqual({ value: 5800, source: "inherited", file: `${CFG}Engine_Base.conf` });
    expect(r.RpmIdle.value).toBe(800);
    expect(r.Inertia.value).toBe(0.4);
    expect(r.Friction.value).toBe(70);
    // In no prefab or conf: only the component template has it.
    expect(r.RpmMax).toEqual({ value: 7000, source: "template", file: `${P}Core/Components/VehicleWheeledSimulation_Base.ct` });
  });

  it("ranks the same-path vanilla prefab right after the override, before its own parents", () => {
    // Workbench writes the original's own parent line into the override copy, which holds no values.
    const shadow = `${P}Wheeled/Fix/Fix_shadow.et`;
    const r = resolve(leaf("Wheeled/Fix/Fix_base.et"), shadow);
    // Fix_shadow.et says 90; its parent Fix_base.et would give 60 from Engine_Fix.conf.
    expect(r.MaxPower).toEqual({ value: 90, source: "inherited", file: shadow });
    expect(r.MaxTorque).toEqual({ value: 190, source: "inherited", file: `${CFG}Engine_Fix.conf` });
  });

  it("leaves values unresolved when no baseline can be read", () => {
    const r = resolveEngineFields({ modText: leaf("Wheeled/Fix/Fix.et", engine("     MaxPower 75\n")), relPath: MOD, readFile: () => null });
    expect(r.MaxPower).toEqual({ value: 75, source: "own", file: MOD });
    expect(r.MaxTorque).toEqual({ value: null, source: "unresolved" });
  });
});

describe("resolveEngineFields, parent chain", () => {
  // join() gives OS-native separators; normalise back to the map's posix keys.
  const norm = (p: string) => p.split("\\").join("/").replace("/addon/", "");
  const et = (parent: string | null, fields: string) =>
    `Vehicle${parent ? ` : "${parent}"` : ""} {\n${engine(fields)}}\n`;
  const resolve = (files: Record<string, string>, child: string) =>
    resolveEngineFields({ modText: child, relPath: "A/Child.et", addonPath: "/addon", readFile: (p) => files[norm(p)] ?? null });

  it("takes a field deleted from the child from its nearest ancestor", () => {
    const r = resolve(
      { "A/Base.et": et(null, "     RpmMax 6000\n     MaxPower 50\n"), "A/Mid.et": et("{BBBB2222}A/Base.et", "     MaxPower 60\n") },
      et("{AAAA1111}A/Mid.et", "     MaxPower 75\n")
    );
    expect(r.MaxPower).toEqual({ value: 75, source: "own", file: "A/Child.et" });
    expect(r.RpmMax).toEqual({ value: 6000, source: "inherited", file: "A/Base.et" });
  });

  it("prefers the nearest ancestor when several define the same field", () => {
    const r = resolve(
      { "A/Base.et": et(null, "     RpmMax 6000\n"), "A/Mid.et": et("{BBBB2222}A/Base.et", "     RpmMax 7000\n") },
      et("{AAAA1111}A/Mid.et", "     MaxPower 75\n")
    );
    expect(r.RpmMax.value).toBe(7000);
  });

  it("survives a cyclic parent reference instead of hanging", () => {
    const r = resolve(
      { "A/X.et": et("{CCCC3333}A/Y.et", "     RpmMax 6000\n"), "A/Y.et": et("{CCCC3333}A/X.et", "     MaxPower 10\n") },
      et("{CCCC3333}A/X.et", "")
    );
    expect(r.RpmMax.value).toBe(6000);
  });
});
