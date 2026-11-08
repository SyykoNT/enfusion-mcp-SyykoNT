import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChassis, TYRE_MODEL_GROUPS } from "../../src/tuning-server/resolve-chassis.js";

// Hand-written 1.9-shaped prefabs and confs with made-up numbers: the vanilla data tree.
const VANILLA = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vanilla");
const P = "Prefabs/Vehicles/";
const FRONT = "4D8B26DF957A8E1C";
const REAR = "4D8B26DF8CF2F3D8";

/** The vehicle's own .et, at a path that has no vanilla twin. */
const leaf = (parent: string, body = "") => `Vehicle : "{ABCD0000AAAA0001}${P}${parent}" {\n${body}}\n`;
const sim = (inner: string) =>
  ` components {\n  VehicleWheeledSimulation "{731B26FCA2F19855}" {\n   Simulation Wheeled "{4D8B26DEA5F25978}" {\n${inner}   }\n  }\n }\n`;
const resolve = (modText: string) =>
  resolveChassis({ modText, relPath: `${P}Wheeled/Mod/Mod.et`, extractedPath: VANILLA });

const FIX_BASE = `${P}Wheeled/Fix/Fix_base.et`;

describe("TyreModel", () => {
  it("returns the class, id, conf and the T1 key sets for Pacejka2002", () => {
    const t = resolve(leaf("Wheeled/Fix/Fix.et")).tyreModel!;
    expect(t.class).toBe("Pacejka2002");
    expect(t.id).toBe("6A38CB253C2D7203");
    expect(t.conf).toBe(`${P}Core/Configs/Pacejka/Pacejka2002_Fix.conf`);
    expect(Object.keys(t.groups)).toEqual(["top", "Longitudinal", "Lateral", "CombinedLongitudinal", "CombinedLateral", "Aligning"]);
    const sizes = Object.fromEntries(Object.entries(t.groups).map(([g, f]) => [g, Object.keys(f).length]));
    expect(sizes).toEqual({ top: 2, Longitudinal: 14, Lateral: 18, CombinedLongitudinal: 6, CombinedLateral: 13, Aligning: 34 });
    expect(t.groups.Aligning).not.toHaveProperty("QDZ5");
  });

  it("takes the prefab's inline values first, then the conf chain, naming the source and file", () => {
    const own = sim(
      `    TyreModel Pacejka2002 "{6A38CB253C2D7203}" {\n     NominalLoad 4800\n     Lateral Pacejka2002Lateral "{69E0A8514AD63F1B}" {\n      PCY1 1.7\n     }\n    }\n`
    );
    const g = resolve(leaf("Wheeled/Fix/Fix.et", own)).tyreModel!.groups;
    expect(g.top.NominalLoad).toEqual({ value: 4800, source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    expect(g.Lateral.PCY1).toEqual({ value: 1.7, source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    // Not in the mod: the vehicle's conf, then the conf's parent, then the parent prefab's inline value.
    expect(g.top.NominalRadius).toEqual({ value: 0.37, source: "inherited", file: FIX_BASE });
    expect(g.Longitudinal.PCX1).toEqual({ value: 1.6, source: "inherited", file: `${P}Core/Configs/Pacejka/Pacejka2002_Fix.conf` });
    expect(g.Longitudinal.PDX2).toEqual({ value: -0.1, source: "inherited", file: `${P}Core/Configs/Pacejka/Pacejka2002_base.conf` });
    expect(g.Longitudinal.PEX1).toEqual({ value: null, source: "unresolved" });
  });

  it("reads Pacejka94 with its Aligning group (c0 to c14, c16, c17)", () => {
    const t = resolve(leaf("Wheeled/P94/P94.et")).tyreModel!;
    expect(t.class).toBe("Pacejka94");
    expect(Object.keys(t.groups)).toEqual(["Longitudinal", "Lateral", "Aligning"]);
    expect(Object.keys(t.groups.Longitudinal)).toHaveLength(11);
    expect(Object.keys(t.groups.Lateral)).toHaveLength(15);
    expect(Object.keys(t.groups.Aligning)).toHaveLength(17);
    expect(t.groups.Aligning).not.toHaveProperty("c15");
    expect(t.groups.Longitudinal.b0.value).toBe(1.6);
    expect(t.groups.Aligning.c17.value).toBe(0.1);
    expect(TYRE_MODEL_GROUPS.Pacejka94).not.toHaveProperty("top");
  });

  it("returns an unknown class by name with no groups, not an error", () => {
    const t = resolve(leaf("Wheeled/Odd/Odd.et")).tyreModel!;
    expect(t.class).toBe("PacejkaNext");
    expect(t.id).toBe("51DAB4E5E8918501");
    expect(t.groups).toEqual({});
  });

  it("is null when no file in the chain has a TyreModel", () => {
    expect(resolve(leaf("Core/Wheeled_Base.et")).tyreModel).toBeNull();
  });

  it("follows a child that switches the TyreModel conf and gives it a different block ID", () => {
    const t = resolve(leaf("Wheeled/Fix/Fix_rally_base.et")).tyreModel!;
    expect(t.id).toBe("6A36E2190A2E41D5");
    expect(t.conf).toBe(`${P}Core/Configs/Pacejka/Pacejka2002_Rally.conf`);
    const g = t.groups;
    expect(g.top.NominalLoad).toEqual({ value: 4600, source: "inherited", file: `${P}Wheeled/Fix/Fix_rally_base.et` });
    expect(g.Longitudinal.PDX1.value).toBe(0.885);
    // Nearest first per key: the child's conf chain answers before the parent prefab's inline value
    // and the parent's conf (PCX1 1.9 not 1.6; NominalRadius 0.38 not 0.37; PCY1 1.2 not 1.3).
    expect(g.Longitudinal.PCX1).toEqual({ value: 1.9, source: "inherited", file: `${P}Core/Configs/Pacejka/Pacejka2002_Rally.conf` });
    expect(g.top.NominalRadius.value).toBe(0.38);
    expect(g.Lateral.PCY1.value).toBe(1.2);
    expect(g.Aligning.QBZ1.value).toBe(8.5);
  });
});

describe("axles", () => {
  const fix = resolve(leaf("Wheeled/Fix/Fix.et"));

  it("inherits everything for a leaf with no Simulation block, in base order, keyed by ID", () => {
    expect(fix.axles.map((a) => [a.id, a.index])).toEqual([[FRONT, 0], [REAR, 1]]);
  });

  it("returns suspension, tyre, steering and wheel groups per axle with their block IDs", () => {
    const [front, rear] = fix.axles;
    expect(front.suspension.id).toBe("4D8B26DFF8859A7B");
    expect(front.steering.id).toBe("AAAA000000000001");
    expect(rear.steering.id).toBe("AAAA000000000002");
    expect(front.tyre.id).toBe("4D8B26DFFD85E58F");
    expect(front.steering.fields.SteeringRatio).toEqual({ value: 15, source: "inherited", file: FIX_BASE });
    expect(front.steering.fields.PowerSteeringFactor.value).toBe(0.5);
    expect(rear.steering.fields.SteeringRatio.value).toBe(0);
    expect(front.suspension.fields.MaxSteeringAngle.value).toBe(28);
    expect(front.suspension.fields.SpringRate.file).toBe(`${P}Core/Configs/Suspension/Suspension_Fix.conf`);
    expect(front.tyre.fields.LongitudinalFriction.value).toBe(1.1);
    expect(front.tyre.fields.Roughness).toEqual({ value: 0.01, source: "inherited", file: `${P}Core/Configs/Tyre/Tyre_Base.conf` });
  });

  it("fills a missing value from the component template and says so", () => {
    const [front, rear] = fix.axles;
    const ct = `${P}Core/Components/VehicleWheeledSimulation_Base.ct`;
    expect(front.suspension.fields.MaxTravelDown).toEqual({ value: 0.2, source: "template", file: ct });
    expect(rear.wheel.fields.Radius).toEqual({ value: 0.4, source: "template", file: ct });
    expect(rear.wheel.fields.BrakeTorque).toEqual({ value: 5000, source: "template", file: ct });
    expect(front.wheel.fields.Radius.value).toBe(0.37);
    expect(rear.suspension.fields.MaxSteeringAngle.value).toBeNull();
    expect(fix.aerodynamics.ReferenceArea).toEqual({ value: 3, source: "template", file: ct });
    expect(fix.aerodynamics.DragCoefficient.value).toBe(0.4);
  });

  it("lets an override copy see the vanilla leaf at its path before the leaf's parents", () => {
    const shadow = `${P}Wheeled/Fix/Fix_shadow.et`;
    const r = resolveChassis({ modText: leaf("Wheeled/Fix/Fix_base.et"), relPath: shadow, extractedPath: VANILLA });
    // Fix_shadow.et says 0.55; its parent Fix_base.et says 0.4.
    expect(r.aerodynamics.DragCoefficient).toEqual({ value: 0.55, source: "inherited", file: shadow });
  });

  it("shows TorqueShare read-only with a note, and Swaybar only where one exists", () => {
    const [front, rear] = fix.axles;
    expect(front.torqueShare.value).toBe(0.5);
    expect(front.torqueShare.note).toBe("present in 1.9 data, unverified whether read");
    expect(front.swaybar!.fields.Stiffness.value).toBe(2500);
    expect(rear.swaybar).toBeUndefined();
  });

  it("lands a child override of only the second axle on that axle, matching Steering by name not ID", () => {
    const mod = leaf(
      "Wheeled/Fix/Fix_rally_base.et",
      sim(`    Axles {\n     Axle "{${REAR}}" {\n      Tyre Tyre "{4D8B26DF33F76974}" {\n       RollingDrag 0.3\n      }\n     }\n    }\n`)
    );
    const r = resolve(mod);
    expect(r.axles).toHaveLength(2);
    const [front, rear] = r.axles;
    // The rally parent gave the rear Steering a different block ID than Fix_base: one steering, the nearest ID.
    expect(rear.steering.id).toBe("BBBB000000000002");
    expect(rear.steering.fields.SteeringRatio).toEqual({ value: 20, source: "inherited", file: `${P}Wheeled/Fix/Fix_rally_base.et` });
    expect(front.steering.id).toBe("AAAA000000000001");
    expect(front.steering.fields.SteeringRatio.value).toBe(15);
    // The tyre switches its conf: own inline first, then the child's conf chain before the parent's.
    expect(rear.tyre.fields.RollingDrag).toEqual({ value: 0.3, source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    expect(rear.tyre.fields.LateralFriction.value).toBe(1.4);
    expect(rear.tyre.fields.LongitudinalFriction).toEqual({ value: 1.6, source: "inherited", file: `${P}Core/Configs/Tyre/Tyre_Rally.conf` });
    expect(front.tyre.fields.LongitudinalFriction.value).toBe(1.1);
    expect(front.tyre.fields.RollingDrag.value).toBe(0.1);
  });
});

describe("differentials", () => {
  it("returns the centre and the per-axle forms, each matched by name", () => {
    const d = resolve(leaf("Wheeled/Fix/Fix.et")).differentials;
    expect(d.map((x) => [x.name, x.location])).toEqual([["Diff_C", "centre"], ["Diff_01", FRONT], ["Diff_02", REAR]]);
    const [centre, d1, d2] = d;
    expect(centre.type).toEqual({ value: "Locked", source: "inherited", file: FIX_BASE });
    expect(centre.parent.value).toBe("Gearbox");
    expect(centre.output1.value).toBe("Diff_02");
    expect(d1.type.value).toBe("LSD");
    expect(d1.fields.Ratio).toEqual({ value: 4.3, source: "inherited", file: `${P}Core/Configs/Differentials/Diff_Fix.conf` });
    expect(d1.fields.Strength.value).toBe(0.5);
    expect(d2.fields.Ratio).toEqual({ value: 5.1, source: "inherited", file: FIX_BASE });
    expect(d2.type.value).toBeNull();
  });

  it("returns every centre differential of a chain and lets a child override one by name", () => {
    const mod = leaf(
      "Wheeled/Fix/Fix.et",
      sim(
        `    Differentials {\n     Differential Diff_C {\n      Type LSD\n      Strength 0.7\n     }\n     Differential Diff_02_03 {\n      Parent "Diff_C"\n      Type Locked\n     }\n    }\n`
      )
    );
    const d = resolve(mod).differentials.filter((x) => x.location === "centre");
    expect(d.map((x) => x.name)).toEqual(["Diff_C", "Diff_02_03"]);
    expect(d[0].type).toEqual({ value: "LSD", source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    expect(d[0].fields.Strength.value).toBe(0.7);
    expect(d[0].parent.value).toBe("Gearbox");
    expect(d[1].parent.value).toBe("Diff_C");
  });
});

describe("gearbox and append arrays", () => {
  it("reads Forward from the conf chain and Reverse from the nearest prefab", () => {
    const { gearbox } = resolve(leaf("Wheeled/Fix/Fix.et"));
    expect(gearbox.reverse).toEqual({ value: 4.5, source: "inherited", file: FIX_BASE });
    expect(gearbox.forward.value).toEqual([3.9, 2.2, 1.3, 0.9]);
    expect(gearbox.forward.file).toBe(`${P}Core/Configs/Transmissions/Transmission_Fix.conf`);
  });

  it("takes the template's Forward and Reverse when nothing nearer has them", () => {
    const { gearbox } = resolve(leaf("Core/Wheeled_Base.et"));
    expect(gearbox.reverse.source).toBe("template");
    expect(gearbox.forward).toMatchObject({ value: [4], source: "template", appended: false });
  });

  it("parses a +{ array without breaking the block finder or reading its numbers as keys", () => {
    const mod = leaf(
      "Wheeled/Fix/Fix.et",
      sim(
        `    Gearbox Gearbox Gearbox {\n     Forward +{\n      0.7\n      0.5\n     }\n     Reverse 5\n    }\n    Axles {\n     Axle "{${REAR}}" {\n      Steering Steering "{AAAA000000000002}" {\n       SteeringRatio 21\n      }\n     }\n    }\n`
      )
    );
    const r = resolve(mod);
    expect(r.gearbox.reverse).toEqual({ value: 5, source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    // The appended entries are flagged, the base list is still the conf's.
    expect(r.gearbox.forward).toMatchObject({ value: [3.9, 2.2, 1.3, 0.9], appended: true });
    // The blocks after the array are still found.
    expect(r.axles[1].steering.fields.SteeringRatio).toEqual({ value: 21, source: "own", file: `${P}Wheeled/Mod/Mod.et` });
    expect(r.axles).toHaveLength(2);
  });
});
