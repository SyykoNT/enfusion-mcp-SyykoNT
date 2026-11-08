import { describe, it, expect } from "vitest";
import { planBlockWrites, formatNumber, type WritePlan } from "../../src/tuning-server/et-write.js";
import { resolveChassis } from "../../src/tuning-server/resolve-chassis.js";

const FRONT = "4D8B26DF957A8E1C";
const REAR = "4D8B26DF8CF2F3D8";

// A hand-written 1.9 vehicle override (made-up numbers): an Engine, a gearbox with a
// `+{` append array, a centre differential, a front axle holding every part and a
// per-axle differential, a rear axle with only a Tyre, and a Pacejka2002 TyreModel
// with one sub-group.
const VEHICLE = `Vehicle : "{11110000AAAA000A}Prefabs/Vehicles/Wheeled/Fix/Fix_base.et" {
 ID "11110000AAAA0010"
 components {
  SCR_VehicleSoundComponent "{55C2E66AD4EF2CA6}" {
   Filenames + {
    "{D89573B95647C34A}Sounds/A.acp"
   }
  }
  VehicleWheeledSimulation "{731B26FCA2F19855}" {
   Simulation Wheeled "{4D8B26DEA5F25978}" {
    Engine Engine Engine {
     MaxPower 90
    }
    Gearbox Gearbox Gearbox {
     Reverse 4.5
     Forward +{
      0.8
     }
    }
    Differentials {
     Differential Diff_C {
      Type LSD
      Ratio 1.5
     }
    }
    Axles {
     Axle "{${FRONT}}" {
      TorqueShare 0.5
      Differential Differential Diff_01 {
       Parent "Diff_C"
      }
      Steering Steering "{BBBB000000000001}" {
       SteeringRatio 18
      }
      Suspension Suspension "{4D8B26DFF8859A7B}" {
       SpringRate 30000
      }
      Wheel Wheel "{4D8B26DFFE211745}" {
       Parent "Diff_01"
      }
      Tyre Tyre "{CCCC000000000001}" {
      }
      Swaybar Swaybar "{66A2C7C16642557A}" {
       Stiffness 2500
      }
     }
     Axle "{${REAR}}" {
      Tyre Tyre "{CCCC000000000002}" {
       LateralFriction 1.2
      }
     }
    }
    TyreModel Pacejka2002 "{6A36E2190A2E41D5}" : "{11110000AAAA000D}Prefabs/Vehicles/Core/Configs/Pacejka/Pacejka2002_Rally.conf" {
     NominalLoad 4600
     Longitudinal Pacejka2002Longitudinal "{69E0A8514AD63F2E}" {
      PDX1 0.885
     }
    }
   }
  }
 }
}
`;

const P94 = `Vehicle : "{11110000AAAA0001}Prefabs/Vehicles/Core/Wheeled_Base.et" {
 components {
  VehicleWheeledSimulation "{731B26FCA2F19855}" {
   Simulation Wheeled "{4D8B26DEA5F25978}" {
    TyreModel Pacejka94 "{51DAB4E5E8918500}" : "{11110000AAAA00E4}Prefabs/Vehicles/Core/Configs/PacejkaTire_Fix.conf" {
     Longitudinal Pacejka94Longitudinal "{51DAB4E5E89185CD}" {
      b0 1.5
     }
    }
   }
  }
 }
}
`;

/** Apply exact one-off replacements, each of which must match exactly once. */
function edit(text: string, pairs: [string, string][]): string {
  for (const [from, to] of pairs) {
    expect(text.split(from).length, `exactly one ${JSON.stringify(from)}`).toBe(2);
    text = text.replace(from, to);
  }
  return text;
}

function written(plan: WritePlan): string {
  if (!plan.ok) throw new Error(`expected a write, got ${plan.status}: ${plan.message}`);
  return plan.text;
}

// One change in every writable block, mixing replaced keys and inserted keys.
const ALL_CHANGES = {
  engine: { MaxPower: 120, RpmIdle: 800 },
  tyreModel: { top: { NominalLoad: 5000, NominalRadius: 0.4 }, Longitudinal: { PCX1: 1.65 } },
  axles: [
    {
      axle: FRONT,
      steering: { SteeringRatio: 16 },
      suspension: { CompressionDamper: 2500 },
      wheel: { Radius: 0.38 },
      tyre: { Roughness: 0.2 },
      swaybar: { Stiffness: 3000 },
    },
    { axle: REAR, tyre: { LateralFriction: 1.3 } },
  ],
  differentials: [
    { name: "Diff_C", fields: { Ratio: 1.6 } },
    { name: "Diff_01", axle: FRONT, fields: { Ratio: 4.1, Strength: 0.5 } },
  ],
};

const ALL_EXPECTED: [string, string][] = [
  ["     MaxPower 90\n    }", "     MaxPower 120\n     RpmIdle 800\n    }"],
  ["      Ratio 1.5", "      Ratio 1.6"],
  ['       Parent "Diff_C"\n      }', '       Parent "Diff_C"\n       Ratio 4.1\n       Strength 0.5\n      }'],
  ["       SteeringRatio 18", "       SteeringRatio 16"],
  ["       SpringRate 30000\n      }", "       SpringRate 30000\n       CompressionDamper 2500\n      }"],
  ['       Parent "Diff_01"\n      }', '       Parent "Diff_01"\n       Radius 0.38\n      }'],
  ['"{CCCC000000000001}" {\n      }', '"{CCCC000000000001}" {\n       Roughness 0.2\n      }'],
  ["       Stiffness 2500", "       Stiffness 3000"],
  ["       LateralFriction 1.2", "       LateralFriction 1.3"],
  ["     NominalLoad 4600", "     NominalLoad 5000"],
  ["      PDX1 0.885\n     }\n    }", "      PDX1 0.885\n      PCX1 1.65\n     }\n     NominalRadius 0.4\n    }"],
];

describe("planBlockWrites: where values go", () => {
  it("writes one value into every block kind in one call, inserts included, and changes nothing else (LF)", () => {
    const out = written(planBlockWrites(VEHICLE, ALL_CHANGES));
    expect(out).toBe(edit(VEHICLE, ALL_EXPECTED));
  });

  it("does the same on a CRLF file and keeps every line ending CRLF", () => {
    const crlf = VEHICLE.replace(/\n/g, "\r\n");
    const out = written(planBlockWrites(crlf, ALL_CHANGES));
    const expected = edit(VEHICLE, ALL_EXPECTED).replace(/\n/g, "\r\n");
    expect(out).toBe(expected);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps each line's own ending in a file with mixed endings", () => {
    const mixed = VEHICLE.replace("     MaxPower 90\n", "     MaxPower 90\r\n");
    const out = written(planBlockWrites(mixed, { engine: { MaxPower: 91, RpmMax: 6000 } }));
    expect(out).toBe(mixed.replace("     MaxPower 90\r\n", "     MaxPower 91\r\n     RpmMax 6000\r\n"));
  });

  it("inserts into two blocks in one call without shifting either (bottom-up)", () => {
    const out = written(
      planBlockWrites(VEHICLE, { engine: { RpmIdle: 800 }, axles: [{ axle: FRONT, tyre: { Roughness: 0.2, Tread: 0.01 } }] })
    );
    expect(out).toBe(
      edit(VEHICLE, [
        ["     MaxPower 90\n    }", "     MaxPower 90\n     RpmIdle 800\n    }"],
        ['"{CCCC000000000001}" {\n      }', '"{CCCC000000000001}" {\n       Roughness 0.2\n       Tread 0.01\n      }'],
      ])
    );
  });

  it("writes into the differential inside an axle, not the centre one", () => {
    const out = written(planBlockWrites(VEHICLE, { differentials: [{ name: "Diff_01", axle: FRONT, fields: { Ratio: 4.1 } }] }));
    expect(out).toBe(edit(VEHICLE, [['       Parent "Diff_C"\n      }', '       Parent "Diff_C"\n       Ratio 4.1\n      }']]));
  });

  it("matches the axle ID without regard to case", () => {
    const out = written(planBlockWrites(VEHICLE, { axles: [{ axle: REAR.toLowerCase(), tyre: { LateralFriction: 1.3 } }] }));
    expect(out).toBe(edit(VEHICLE, [["       LateralFriction 1.2", "       LateralFriction 1.3"]]));
  });

  it("leaves the +{ append arrays byte-identical", () => {
    const out = written(planBlockWrites(VEHICLE, ALL_CHANGES));
    expect(out).toContain("     Forward +{\n      0.8\n     }\n");
    expect(out).toContain('   Filenames + {\n    "{D89573B95647C34A}Sounds/A.acp"\n   }\n');
  });

  it("refuses to write into a block whose header is a +{ append array", () => {
    const text = VEHICLE.replace('Tyre Tyre "{CCCC000000000002}" {', "Tyre +{");
    const plan = planBlockWrites(text, { axles: [{ axle: REAR, tyre: { LateralFriction: 1.3 } }] });
    expect(plan).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a block whose closing brace is not on its own line", () => {
    const text = VEHICLE.replace('Tyre Tyre "{CCCC000000000001}" {\n      }', 'Tyre Tyre "{CCCC000000000001}" { }');
    const plan = planBlockWrites(text, { axles: [{ axle: FRONT, tyre: { Roughness: 0.2 } }] });
    expect(plan).toMatchObject({ ok: false, status: 409 });
  });
});

describe("planBlockWrites: numbers", () => {
  it("formats in plain decimal, never with an exponent", () => {
    expect(formatNumber(0.0000001)).toBe("0.0000001");
    expect(formatNumber(-1.5e-10)).toBe("-0.00000000015");
    expect(formatNumber(1e21)).toBe("1000000000000000000000");
    expect(formatNumber(1.2345e25)).toBe("12345000000000000000000000");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(4.1)).toBe("4.1");
    expect(formatNumber(30000)).toBe("30000");
  });

  it("round-trips 0.0000001 through the reader, and a second write does not duplicate the key", () => {
    const once = written(planBlockWrites(VEHICLE, { axles: [{ axle: FRONT, tyre: { Roughness: 0.0000001 } }] }));
    const twice = written(planBlockWrites(once, { axles: [{ axle: FRONT, tyre: { Roughness: 0.0000001 } }] }));
    expect(twice).toBe(once);
    expect(twice.match(/Roughness/g)).toHaveLength(1);
    expect(twice).toContain("       Roughness 0.0000001\n");
    const chassis = resolveChassis({ modText: twice, relPath: "Prefabs/Vehicles/Wheeled/Fix/Fix.et", readFile: () => null });
    expect(chassis.axles.find((a) => a.id === FRONT)!.tyre.fields.Roughness).toMatchObject({ value: 0.0000001, source: "own" });
  });

  it("replaces a key that an older writer left in exponent form instead of adding a second one", () => {
    const text = VEHICLE.replace("       Stiffness 2500", "       Stiffness 1e-7");
    const out = written(planBlockWrites(text, { axles: [{ axle: FRONT, swaybar: { Stiffness: 2 } }] }));
    expect(out).toBe(VEHICLE.replace("       Stiffness 2500", "       Stiffness 2"));
  });

  it("writes negative zero as 0", () => {
    const out = written(planBlockWrites(VEHICLE, { engine: { MaxPower: -0 } }));
    expect(out).toContain("     MaxPower 0\n");
  });
});

describe("planBlockWrites: refusals write nothing", () => {
  const status = (text: string, changes: unknown) => {
    const plan = planBlockWrites(text, changes);
    return plan.ok ? 200 : plan.status;
  };

  it.each([
    ["a Pacejka2002 key into a Pacejka94 block", P94, { tyreModel: { Longitudinal: { PCX1: 1 } } }],
    ["the top group on Pacejka94 (it has none)", P94, { tyreModel: { top: { NominalLoad: 1 } } }],
    ["a 1.8-only Aligning key (QDZ5)", VEHICLE, { tyreModel: { Aligning: { QDZ5: 1 } } }],
    ["an unknown TyreModel group", VEHICLE, { tyreModel: { Combined: { RBX1: 1 } } }],
    ["a prototype name as a group", VEHICLE, { tyreModel: { constructor: { PCX1: 1 } } }],
    ["TorqueShare as an axle part", VEHICLE, { axles: [{ axle: FRONT, torqueShare: { TorqueShare: 0.4 } }] }],
    ["TorqueShare inside Suspension", VEHICLE, { axles: [{ axle: FRONT, suspension: { TorqueShare: 0.4 } }] }],
    ["a differential Type (enum)", VEHICLE, { differentials: [{ name: "Diff_C", fields: { Type: 1 } }] }],
    ["a differential Parent (string)", VEHICLE, { differentials: [{ name: "Diff_C", fields: { Parent: 1 } }] }],
    ["an unknown engine key", VEHICLE, { engine: { NotAField: 1 } }],
    ["a key with a space", VEHICLE, { engine: { "Max Power": 1 } }],
    ["a key with trailing whitespace", VEHICLE, { engine: { "MaxPower ": 1 } }],
    ["a string that looks numeric", VEHICLE, { engine: { MaxPower: "120" } }],
    ["NaN as a string", VEHICLE, { engine: { MaxPower: "NaN" } }],
    ["Infinity", VEHICLE, { engine: { MaxPower: Infinity } }],
    ["NaN", VEHICLE, { engine: { MaxPower: NaN } }],
    ["null", VEHICLE, { engine: { MaxPower: null } }],
    ["a boolean", VEHICLE, { engine: { MaxPower: true } }],
    ["an unknown part", VEHICLE, { gearbox: { Reverse: 4 } }],
    ["the 1.8 flat engine body", VEHICLE, { MaxPower: 75 }],
    ["an axle ID with braces", VEHICLE, { axles: [{ axle: `{${FRONT}}`, tyre: { Roughness: 0.2 } }] }],
    ["the same axle twice", VEHICLE, { axles: [{ axle: FRONT, tyre: { Roughness: 0.2 } }, { axle: FRONT, wheel: { Radius: 1 } }] }],
    ["the same differential twice", VEHICLE, { differentials: [{ name: "Diff_C", fields: { Ratio: 1 } }, { name: "Diff_C", fields: { Strength: 1 } }] }],
    ["axles that is not an array", VEHICLE, { axles: { axle: FRONT } }],
    ["no values at all", VEHICLE, { engine: {} }],
    ["changes that is not an object", VEHICLE, [1]],
    ["missing changes", VEHICLE, undefined],
  ])("400 for %s", (_name, text, changes) => {
    expect(status(text, changes)).toBe(400);
  });

  it("accepts a Pacejka94 key in a Pacejka94 block", () => {
    const out = written(planBlockWrites(P94, { tyreModel: { Longitudinal: { b0: 1.7 } } }));
    expect(out).toBe(P94.replace("      b0 1.5", "      b0 1.7"));
  });

  it("allows the 1.9 engine keys RpmRedline and InertiaCoupled", () => {
    const out = written(planBlockWrites(VEHICLE, { engine: { RpmRedline: 5200, InertiaCoupled: 0.2 } }));
    expect(out).toContain("     MaxPower 90\n     RpmRedline 5200\n     InertiaCoupled 0.2\n    }");
  });

  it("409 naming every missing block, even when the other blocks exist", () => {
    const plan = planBlockWrites(VEHICLE, {
      engine: { MaxPower: 100 },
      axles: [{ axle: REAR, steering: { SteeringRatio: 20 } }, { axle: "ABCDEF0123456789", tyre: { Roughness: 1 } }],
      tyreModel: { Aligning: { QBZ1: 1 } },
      differentials: [{ name: "Diff_02", axle: REAR, fields: { Ratio: 5 } }],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.status).toBe(409);
    expect(plan.message).toContain("Add the override in Workbench first");
    expect(plan.errors).toEqual([
      "TyreModel Aligning is not in this .et",
      `Axle ${REAR} Steering is not in this .et`,
      "Axle ABCDEF0123456789 Tyre is not in this .et",
      `Differential Diff_02 in axle ${REAR} is not in this .et`,
    ]);
  });

  it("409 when the vehicle has no TyreModel at all", () => {
    const noTyreModel = VEHICLE.replace(/    TyreModel[\s\S]*?\n    }\n/, "");
    expect(noTyreModel).not.toContain("TyreModel");
    expect(status(noTyreModel, { tyreModel: { top: { NominalLoad: 1 } } })).toBe(409);
  });

  it("400 wins over 409 when a request is both malformed and aimed at a missing block", () => {
    expect(status(VEHICLE, { engine: { MaxPower: "x" }, axles: [{ axle: REAR, steering: { SteeringRatio: 20 } }] })).toBe(400);
  });
});
