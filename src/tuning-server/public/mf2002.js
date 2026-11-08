// Magic Formula tyre maths for the tuner page. Pure functions, so the page loads this file
// and a test imports it.
//
// Pacejka2002 follows the published MF 5.2 ("2002") equations (Pacejka, Tire and Vehicle
// Dynamics) with every scaling factor at 1, no turn slip and no pressure terms. Inputs:
// slip ratio kappa (unitless), slip angle alpha and camber gamma in radians, load Fz in N
// (NominalLoad is Fz0 in the same unit). A coefficient the prefab does not set counts as 0.
// A function returns NaN when a coefficient it needs is missing; curve() turns that into a
// flat zero curve with a flag, so the page never draws NaN.

const seq = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** Every Pacejka2002 key the 1.9 data carries, per group (no QDZ5 in that data). */
export const MF2002_GROUPS = {
  top: ["NominalLoad", "NominalRadius"],
  Longitudinal: "PCX1 PDX1 PDX2 PEX1 PEX2 PEX3 PEX4 PKX1 PKX2 PKX3 PHX1 PHX2 PVX1 PVX2".split(" "),
  Lateral: "PCY1 PDY1 PDY2 PDY3 PEY1 PEY2 PEY3 PEY4 PKY1 PKY2 PKY3 PHY1 PHY2 PHY3 PVY1 PVY2 PVY3 PVY4".split(" "),
  CombinedLongitudinal: "RBX1 RBX2 RCX1 REX1 REX2 RHX1".split(" "),
  CombinedLateral: "RBY1 RBY2 RBY3 RCY1 REY1 REY2 RHY1 RVY1 RVY2 RVY3 RVY4 RVY5 RVY6".split(" "),
  Aligning: [
    ...seq("QBZ", 1, 10), "QCZ1", ...seq("QDZ", 1, 4), ...seq("QDZ", 6, 11),
    ...seq("QEZ", 1, 5), ...seq("QHZ", 1, 4), ...seq("QSSZ", 1, 4),
  ],
};

const NOT_IN_FORMULA = "not in the textbook formula";
const UNUSED = {
  QBZ6: NOT_IN_FORMULA,
  QBZ7: NOT_IN_FORMULA,
  QBZ8: NOT_IN_FORMULA,
  QDZ10: NOT_IN_FORMULA,
  QDZ11: NOT_IN_FORMULA,
  ...Object.fromEntries(seq("QSSZ", 1, 4).map((k) => [k, "combined-slip Mz term (s times Fx), not drawn here"])),
};

/** `PCX1` is the book's p_Cx1: lower-case owner letter, upper-case factor, lower-case axis. */
function symbolOf(key) {
  if (key === "NominalLoad") return "Fz0";
  if (key === "NominalRadius") return "R0";
  if (key.startsWith("QSSZ")) return `ssz${key.slice(4)}`;
  return key[0].toLowerCase() + key[1] + key[2].toLowerCase() + key.slice(3);
}

/** Key to textbook symbol, and whether the curves on the page use it. */
export const KEY_TABLE = Object.fromEntries(
  Object.entries(MF2002_GROUPS).flatMap(([group, keys]) =>
    keys.map((key) => [key, { group, symbol: symbolOf(key), used: !(key in UNUSED), ...(key in UNUSED ? { note: UNUSED[key] } : {}) }])
  )
);

const c = (p, key) => (typeof p[key] === "number" ? p[key] : 0);
const capE = (e) => Math.min(1, e);
/** y = D sin(C atan(Bx - E(Bx - atan Bx))) */
const magic = (x, B, C, D, E) => D * Math.sin(C * Math.atan(B * x - E * (B * x - Math.atan(B * x))));

function load(p, Fz) {
  const Fz0 = c(p, "NominalLoad");
  return { Fz0, dfz: (Fz - Fz0) / Fz0 };
}

/** Pure longitudinal force Fx0(kappa). */
export function fx0(p, kappa, Fz) {
  const { dfz } = load(p, Fz);
  const kx = kappa + c(p, "PHX1") + c(p, "PHX2") * dfz;
  const C = c(p, "PCX1");
  const D = (c(p, "PDX1") + c(p, "PDX2") * dfz) * Fz;
  const E = capE((c(p, "PEX1") + c(p, "PEX2") * dfz + c(p, "PEX3") * dfz * dfz) * (1 - c(p, "PEX4") * Math.sign(kx)));
  const K = Fz * (c(p, "PKX1") + c(p, "PKX2") * dfz) * Math.exp(c(p, "PKX3") * dfz);
  if (C * D === 0 || K === 0) return NaN;
  return magic(kx, K / (C * D), C, D, E) + Fz * (c(p, "PVX1") + c(p, "PVX2") * dfz);
}

function lateral(p, alpha, Fz, gamma) {
  const { Fz0, dfz } = load(p, Fz);
  const SHy = c(p, "PHY1") + c(p, "PHY2") * dfz + c(p, "PHY3") * gamma;
  const ay = alpha + SHy;
  const C = c(p, "PCY1");
  const mu = (c(p, "PDY1") + c(p, "PDY2") * dfz) * (1 - c(p, "PDY3") * gamma * gamma);
  const D = mu * Fz;
  const E = capE((c(p, "PEY1") + c(p, "PEY2") * dfz) * (1 - (c(p, "PEY3") + c(p, "PEY4") * gamma) * Math.sign(ay)));
  const K = c(p, "PKY1") * Fz0 * Math.sin(2 * Math.atan(Fz / (c(p, "PKY2") * Fz0))) * (1 - c(p, "PKY3") * Math.abs(gamma));
  const B = K / (C * D);
  const SVy = Fz * (c(p, "PVY1") + c(p, "PVY2") * dfz + (c(p, "PVY3") + c(p, "PVY4") * dfz) * gamma);
  const Fy0 = C * D === 0 || K === 0 ? NaN : magic(ay, B, C, D, E) + SVy;
  return { Fy0, mu, B, C, K, SHy, SVy, Fz0, dfz };
}

/** Pure lateral force Fy0(alpha). */
export function fy0(p, alpha, Fz, gamma = 0) {
  return lateral(p, alpha, Fz, gamma).Fy0;
}

/** cos(C atan(Bx - E(Bx - atan Bx))), the combined-slip weighting shape. */
const weight = (x, B, C, E) => Math.cos(C * Math.atan(B * x - E * (B * x - Math.atan(B * x))));

/** Combined-slip longitudinal force Fx(kappa) at slip angle alpha. */
export function fx(p, kappa, alpha, Fz) {
  const { dfz } = load(p, Fz);
  const SH = c(p, "RHX1");
  const B = c(p, "RBX1") * Math.cos(Math.atan(c(p, "RBX2") * kappa));
  const C = c(p, "RCX1");
  const E = capE(c(p, "REX1") + c(p, "REX2") * dfz);
  return (weight(alpha + SH, B, C, E) / weight(SH, B, C, E)) * fx0(p, kappa, Fz);
}

/** Combined-slip lateral force Fy(alpha) at slip ratio kappa. */
export function fy(p, kappa, alpha, Fz, gamma = 0) {
  const L = lateral(p, alpha, Fz, gamma);
  const SH = c(p, "RHY1");
  const B = c(p, "RBY1") * Math.cos(Math.atan(c(p, "RBY2") * (alpha - c(p, "RBY3"))));
  const C = c(p, "RCY1");
  const E = capE(c(p, "REY1") + c(p, "REY2") * L.dfz);
  const DV = L.mu * Fz * (c(p, "RVY1") + c(p, "RVY2") * L.dfz + c(p, "RVY3") * gamma) * Math.cos(Math.atan(c(p, "RVY4") * alpha));
  const SV = DV * Math.sin(c(p, "RVY5") * Math.atan(c(p, "RVY6") * kappa));
  return (weight(kappa + SH, B, C, E) / weight(SH, B, C, E)) * L.Fy0 + SV;
}

/** Pure-slip aligning moment Mz0(alpha) = -t Fy0 + Mzr, in N m. */
export function mz0(p, alpha, Fz, gamma = 0) {
  const L = lateral(p, alpha, Fz, gamma);
  const { dfz, Fz0 } = L;
  const R0 = c(p, "NominalRadius");
  const at = alpha + c(p, "QHZ1") + c(p, "QHZ2") * dfz + (c(p, "QHZ3") + c(p, "QHZ4") * dfz) * gamma;
  const Bt = (c(p, "QBZ1") + c(p, "QBZ2") * dfz + c(p, "QBZ3") * dfz * dfz) * (1 + c(p, "QBZ4") * gamma + c(p, "QBZ5") * Math.abs(gamma));
  const Ct = c(p, "QCZ1");
  const Dt = Fz * (c(p, "QDZ1") + c(p, "QDZ2") * dfz) * (1 + c(p, "QDZ3") * gamma + c(p, "QDZ4") * gamma * gamma) * (R0 / Fz0);
  const Et = capE(
    (c(p, "QEZ1") + c(p, "QEZ2") * dfz + c(p, "QEZ3") * dfz * dfz) *
      (1 + (c(p, "QEZ4") + c(p, "QEZ5") * gamma) * (2 / Math.PI) * Math.atan(Bt * Ct * at))
  );
  const t = Dt * weight(at, Bt, Ct, Et) * Math.cos(alpha);
  const ar = alpha + L.SHy + L.SVy / L.K;
  const Br = c(p, "QBZ9") + c(p, "QBZ10") * L.B * L.C;
  const Dr = Fz * (c(p, "QDZ6") + c(p, "QDZ7") * dfz + (c(p, "QDZ8") + c(p, "QDZ9") * dfz) * gamma) * R0;
  return -t * L.Fy0 + Dr * Math.cos(Math.atan(Br * ar)) * Math.cos(alpha);
}

// Pacejka '94 as the page drew it before 1.9: Fz in kN, slip in percent and degrees, result
// as force over load. b0..b10 longitudinal, a0..a14 lateral.

/** Pacejka '94 longitudinal Fx/Fz at slip in percent. */
export function fx94(p, slipPct, FzkN) {
  const C = c(p, "b0");
  const D = (c(p, "b1") * FzkN + c(p, "b2")) * FzkN;
  const BCD = (c(p, "b3") * FzkN * FzkN + c(p, "b4") * FzkN) * Math.exp(-c(p, "b5") * FzkN);
  if (C * D === 0) return NaN;
  const E = c(p, "b6") * FzkN * FzkN + c(p, "b7") * FzkN + c(p, "b8");
  const Sh = c(p, "b9") * FzkN + c(p, "b10");
  return magic(slipPct + Sh, BCD / (C * D), C, D, E) / (FzkN * 1000);
}

/** Pacejka '94 lateral Fy/Fz at slip angle and camber in degrees. */
export function fy94(p, alphaDeg, FzkN, camberDeg = 0) {
  const C = c(p, "a0");
  const D = (c(p, "a1") * FzkN + c(p, "a2")) * FzkN;
  const BCD = c(p, "a3") * Math.sin(2 * Math.atan(FzkN / Math.max(c(p, "a4"), 0.5))) * (1 - c(p, "a5") * Math.abs(camberDeg));
  if (C * D === 0) return NaN;
  const E = c(p, "a6") * FzkN + c(p, "a7");
  const Sh = c(p, "a8") * FzkN + c(p, "a9") + c(p, "a10") * camberDeg;
  const Sv = (c(p, "a11") * FzkN + c(p, "a12")) * FzkN + (c(p, "a13") * FzkN + c(p, "a14")) * camberDeg;
  return (magic(alphaDeg + Sh, BCD / (C * D), C, D, E) + Sv) / (FzkN * 1000);
}

/** Sample f over xs. One non-finite value means a coefficient is missing: the whole curve is flat zero. */
export function curve(f, xs) {
  const ys = xs.map((x) => f(x));
  const missing = !ys.every(Number.isFinite);
  return { pts: xs.map((x, i) => ({ x, y: missing ? 0 : ys[i] })), missing };
}
