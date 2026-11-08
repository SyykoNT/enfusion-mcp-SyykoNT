import { describe, it, expect } from "vitest";
import { fx0, fy0, fx, fy, mz0, fx94, fy94, curve, KEY_TABLE, MF2002_GROUPS } from "../../src/tuning-server/public/mf2002.js";
import { TYRE_MODEL_GROUPS } from "../../src/tuning-server/resolve-chassis.js";

// Made-up but plausible coefficients; every offset term (PHX, PVX, PHY, PVY) is 0.
const BASE: Record<string, number> = {
  NominalLoad: 4000,
  NominalRadius: 0.3,
  PCX1: 1.65, PDX1: 1, PDX2: -0.1, PEX1: 0.4, PEX2: 0.1, PEX3: 0.05, PEX4: 0, PKX1: 20, PKX2: 1, PKX3: -0.2,
  PCY1: 1.3, PDY1: 0.95, PDY2: -0.1, PDY3: 1, PEY1: -0.6, PEY2: 0.1, PEY3: 0, PEY4: 0.3, PKY1: -15, PKY2: 1.7, PKY3: 0.2,
  RBX1: 10, RBX2: 6, RCX1: 1.05, REX1: 0.2, REX2: 0.1, RHX1: 0.01,
  RBY1: 7, RBY2: 2.5, RBY3: 0.02, RCY1: 1.05, REY1: 0.1, REY2: 0.1, RHY1: 0.01,
  RVY1: 0.05, RVY2: 0.02, RVY3: 0.1, RVY4: 100, RVY5: 1.9, RVY6: 10,
  QBZ1: 8, QBZ2: -1, QBZ3: 0.5, QBZ4: 0.2, QBZ5: 0.1, QBZ9: 10, QBZ10: 0.2, QCZ1: 1.2,
  QDZ1: 0.1, QDZ2: -0.01, QDZ3: 0.3, QDZ4: 0.1, QEZ1: -1.5, QEZ2: 0.2, QEZ3: 0, QEZ4: 0.3, QEZ5: 0.1,
};

const LOADS = [2000, 4000, 6500];
const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

describe("Pacejka 2002 maths", () => {
  it("Fx(0) = 0 and Fy(0) = 0, and both are odd, with no offsets, camber 0 and PEX4 = PEY3 = 0", () => {
    for (const Fz of LOADS) {
      expect(fx0(BASE, 0, Fz)).toBeCloseTo(0, 12);
      expect(fy0(BASE, 0, Fz)).toBeCloseTo(0, 12);
      for (const s of [0.01, 0.05, 0.2, 0.8]) {
        expect(fx0(BASE, -s, Fz)).toBeCloseTo(-fx0(BASE, s, Fz), 9);
        expect(fy0(BASE, -s, Fz)).toBeCloseTo(-fy0(BASE, s, Fz), 9);
        expect(Math.abs(fx0(BASE, s, Fz))).toBeGreaterThan(0);
      }
    }
  });

  it("the sampled peak is within 1% of D for 1 <= C < 2, E <= 1 (below the cap) and SV = 0", () => {
    // At Fz = Fz0 (dfz 0) and no load terms, D is PDX1 * Fz and PDY1 * Fz.
    const Fz = 4000;
    const xs = range(-20, 20, 0.001);
    for (const C of [1, 1.3, 1.65, 1.95]) {
      for (const E of [-2, 0, 0.5, 0.9]) {
        const p: Record<string, number> = { ...BASE, PCX1: C, PEX1: E, PEX2: 0, PEX3: 0, PDX2: 0, PCY1: C, PEY1: E, PEY2: 0, PEY4: 0, PDY2: 0, PDY3: 0 };
        const maxX = Math.max(...curve((k) => fx0(p, k, Fz), xs).pts.map((q) => q.y));
        const maxY = Math.max(...curve((a) => fy0(p, a, Fz), xs).pts.map((q) => q.y));
        expect(Math.abs(maxX - p.PDX1 * Fz) / (p.PDX1 * Fz), `Fx C=${C} E=${E}`).toBeLessThan(0.01);
        expect(Math.abs(maxY - p.PDY1 * Fz) / (p.PDY1 * Fz), `Fy C=${C} E=${E}`).toBeLessThan(0.01);
      }
    }
  });

  it("combined Fx at slip angle 0 equals pure Fx, combined Fy at slip ratio 0 equals pure Fy", () => {
    // Offsets on here too: the combined weighting is normalised at its own shift.
    const p = { ...BASE, PHX1: 0.002, PVX1: 0.01, PHY1: 0.003, PVY1: 0.02 };
    for (const Fz of LOADS) {
      for (const s of [-0.6, -0.1, 0, 0.03, 0.4]) {
        expect(fx(p, s, 0, Fz)).toBeCloseTo(fx0(p, s, Fz), 9);
        expect(fy(p, 0, s, Fz, 0.02)).toBeCloseTo(fy0(p, s, Fz, 0.02), 9);
      }
      // And slip in the other direction does reduce the force.
      expect(Math.abs(fx(p, 0.1, 0.15, Fz))).toBeLessThan(Math.abs(fx0(p, 0.1, Fz)));
    }
  });

  it("Mz(0) = 0 with QDZ6 to QDZ11, QHZ1 to QHZ4, PHY, PVY = 0 and camber 0", () => {
    const p = { ...BASE, QDZ6: 0, QDZ7: 0, QDZ8: 0, QDZ9: 0, QDZ10: 0, QDZ11: 0, QHZ1: 0, QHZ2: 0, QHZ3: 0, QHZ4: 0 };
    for (const Fz of LOADS) {
      expect(mz0(p, 0, Fz)).toBeCloseTo(0, 9);
      expect(Number.isFinite(mz0(p, 0.05, Fz))).toBe(true);
      expect(mz0(p, 0.05, Fz)).not.toBe(0);
    }
  });

  it("an all-zero coefficient set gives finite zero curves flagged as missing, never NaN", () => {
    const xs = range(-1, 1, 0.01);
    const zero = Object.fromEntries(Object.values(MF2002_GROUPS).flat().map((k) => [k, 0]));
    for (const p of [zero, {}]) {
      for (const f of [
        (x: number) => fx0(p, x, 4000),
        (x: number) => fy0(p, x, 4000),
        (x: number) => fx(p, x, 0.1, 4000),
        (x: number) => fy(p, 0.1, x, 4000),
        (x: number) => mz0(p, x, 4000),
        (x: number) => fx94(p, x * 100, 4),
        (x: number) => fy94(p, x * 20, 4),
      ]) {
        const c = curve(f, xs);
        expect(c.missing).toBe(true);
        expect(c.pts.every((q) => q.y === 0)).toBe(true);
      }
    }
  });

  it("flags C*D = 0 and a zero nominal load as missing, and draws a full set normally", () => {
    const xs = range(-0.5, 0.5, 0.01);
    expect(curve((k) => fx0({ ...BASE, PCX1: 0 }, k, 4000), xs).missing).toBe(true);
    expect(curve((a) => fy0({ ...BASE, PDY1: 0, PDY2: 0 }, a, 4000), xs).missing).toBe(true);
    expect(curve((k) => fx0({ ...BASE, NominalLoad: 0 }, k, 4000), xs).missing).toBe(true);
    for (const f of [(x: number) => fx0(BASE, x, 4000), (x: number) => fy(BASE, 0.05, x, 4000, 0.01), (x: number) => mz0(BASE, x, 4000, 0.01)]) {
      expect(curve(f, xs).missing).toBe(false);
    }
  });

  it("the key table covers every Pacejka2002 key the server reads, and names the ones the curves leave out", () => {
    expect(MF2002_GROUPS).toEqual(TYRE_MODEL_GROUPS.Pacejka2002);
    expect(Object.keys(KEY_TABLE).sort()).toEqual(Object.values(TYRE_MODEL_GROUPS.Pacejka2002).flat().sort());
    expect(KEY_TABLE.PCX1).toMatchObject({ group: "Longitudinal", symbol: "pCx1", used: true });
    expect(KEY_TABLE.NominalLoad).toMatchObject({ symbol: "Fz0", used: true });
    const unused = Object.keys(KEY_TABLE).filter((k) => !KEY_TABLE[k].used).sort();
    expect(unused).toEqual(["QBZ6", "QBZ7", "QBZ8", "QDZ10", "QDZ11", "QSSZ1", "QSSZ2", "QSSZ3", "QSSZ4"]);
    expect(KEY_TABLE.QDZ10.note).toBe("not in the textbook formula");
  });
});
