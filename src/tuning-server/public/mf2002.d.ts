/** Coefficients by key (`PCX1`, `NominalLoad`, `b0`, ...); a missing key counts as 0. */
export type Coefficients = Record<string, number | undefined>;

export interface KeyInfo {
  group: string;
  symbol: string;
  used: boolean;
  note?: string;
}

export interface Curve {
  pts: { x: number; y: number }[];
  /** True when a needed coefficient was missing; every y is then 0. */
  missing: boolean;
}

export const MF2002_GROUPS: Record<string, string[]>;
export const KEY_TABLE: Record<string, KeyInfo>;

export function fx0(p: Coefficients, kappa: number, Fz: number): number;
export function fy0(p: Coefficients, alpha: number, Fz: number, gamma?: number): number;
export function fx(p: Coefficients, kappa: number, alpha: number, Fz: number): number;
export function fy(p: Coefficients, kappa: number, alpha: number, Fz: number, gamma?: number): number;
export function mz0(p: Coefficients, alpha: number, Fz: number, gamma?: number): number;
export function fx94(p: Coefficients, slipPct: number, FzkN: number): number;
export function fy94(p: Coefficients, alphaDeg: number, FzkN: number, camberDeg?: number): number;
export function curve(f: (x: number) => number, xs: number[]): Curve;
