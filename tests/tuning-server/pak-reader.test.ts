import { describe, it, expect, vi } from "vitest";
import { makeReader } from "../../src/tuning-server/config-chain.js";
import { resolveEngineFields } from "../../src/tuning-server/resolve-engine.js";
import { resolveChassis } from "../../src/tuning-server/resolve-chassis.js";

// join() gives OS-native separators; normalise back to the map's posix keys.
const norm = (p: string) => p.split("\\").join("/").replace("/vanilla/", "").replace("/addon/", "");
const fromMap = (files: Record<string, string>) => (p: string) => files[norm(p)] ?? null;

const REL = "Prefabs/Vehicles/Wheeled/X/X.et";

const et = (engine: string, extra = "") =>
  `Vehicle {\n components {\n  VehicleWheeledSimulation "{7}" {\n   Simulation Wheeled "{4}" {\n${engine}${extra}\n   }\n  }\n }\n}\n`;

const VANILLA_ET = et(
  `    Engine Engine Engine : "{AAAA1111AAAA1111}Cfg/Engine_X.conf" {\n     MaxPower 99\n    }\n`,
  `    Pacejka Pacejka "{5}" : "{BBBB2222BBBB2222}Cfg/Pacejka_X.conf" {\n    }`
);
const ENGINE_CONF = `Engine {
 MaxTorque 250
 RpmIdle 700
}
`;
const PACEJKA_CONF = `Pacejka : "{DDDD4444DDDD4444}Cfg/Pacejka_Base.conf" {\n Longitudinal PacejkaLongitudinal "{9}" {\n  b0 0.8\n }\n}\n`;
const PACEJKA_BASE_CONF = `Pacejka {\n Longitudinal PacejkaLongitudinal "{9}" {\n  b0 1.6\n  b3 20\n }\n}\n`;

// What the installed paks would hold: addon-relative path -> text.
const PAKS: Record<string, string> = {
  [REL]: VANILLA_ET,
  "Cfg/Engine_X.conf": ENGINE_CONF,
  "Cfg/Pacejka_X.conf": PACEJKA_CONF,
  "Cfg/Pacejka_Base.conf": PACEJKA_BASE_CONF,
};
const readBase = (rel: string) => PAKS[rel] ?? null;

// A mod prefab that shadows the vanilla path and defines no values of its own.
const MOD_ET = et(`    Engine Engine Engine {\n     MaxPower 120\n    }\n`);
const noFiles = () => null;

describe("makeReader", () => {
  it("reads the mod copy first, then the base game from the paks when there is no extracted folder", () => {
    const r = makeReader({
      addonPath: "/addon",
      readFile: fromMap({ "Cfg/A.conf": "mod copy" }),
      readBase: (rel) => (rel === "Cfg/A.conf" ? "pak copy" : rel === "Cfg/B.conf" ? "pak B" : null),
    });
    expect(r.ref("{AAAA1111AAAA1111}Cfg/A.conf")).toBe("mod copy");
    expect(r.ref("{AAAA1111AAAA1111}Cfg/B.conf")).toBe("pak B");
    expect(r.copies("{AAAA1111AAAA1111}Cfg/A.conf")).toEqual(["mod copy", "pak copy"]);
    expect(r.ref("{AAAA1111AAAA1111}Cfg/Missing.conf")).toBeNull();
  });

  it("uses the extracted folder and never asks the paks when both exist", () => {
    const paks = vi.fn((rel: string) => PAKS[rel] ?? null);
    const r = makeReader({
      extractedPath: "/vanilla",
      readFile: fromMap({ "Cfg/Engine_X.conf": "extracted copy" }),
      readBase: paks,
    });
    expect(r.base("Cfg/Engine_X.conf")).toBe("extracted copy");
    // A file only the paks have stays unresolved: the extracted folder is the whole base.
    expect(r.base("Cfg/Other.conf")).toBeNull();
    expect(paks).not.toHaveBeenCalled();
  });

  it("treats a pak read that throws as a missing file", () => {
    const r = makeReader({ readBase: () => { throw new Error("File not found in pak"); } });
    expect(r.base("Cfg/A.conf")).toBeNull();
  });
});

describe("tuning values from the paks", () => {
  it("resolves engine values through the vanilla prefab and its conf chain", () => {
    const r = resolveEngineFields({ modText: MOD_ET, relPath: REL, readFile: noFiles, readBase });
    expect(r.MaxPower).toEqual({ value: 120, source: "overridden" });
    expect(r.MaxTorque).toEqual({ value: 250, source: "inherited" });
    expect(r.RpmIdle).toEqual({ value: 700, source: "inherited" });
  });

  it("resolves tyre coefficients through the vanilla prefab and its conf chain", () => {
    const r = resolveChassis({ modText: et(""), relPath: REL, readFile: noFiles, readBase });
    expect(r.longitudinal.b0).toEqual({ value: 0.8, source: "inherited" });
    expect(r.longitudinal.b3).toEqual({ value: 20, source: "inherited" });
  });

  it("leaves values unresolved when neither source has the file", () => {
    const r = resolveEngineFields({ modText: MOD_ET, relPath: REL, readFile: noFiles });
    expect(r.MaxTorque).toEqual({ value: null, source: "unresolved" });
  });

  it("prefers the extracted folder over the paks for the same file", () => {
    const paks = vi.fn(readBase);
    const extracted: Record<string, string> = {
      ...PAKS,
      "Cfg/Engine_X.conf": `Engine {\n MaxTorque 777\n}\n`,
    };
    const r = resolveEngineFields({
      modText: MOD_ET,
      relPath: REL,
      extractedPath: "/vanilla",
      readFile: fromMap(extracted),
      readBase: paks,
    });
    expect(r.MaxTorque).toEqual({ value: 777, source: "inherited" });
    expect(paks).not.toHaveBeenCalled();
  });
});
