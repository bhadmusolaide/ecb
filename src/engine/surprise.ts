/**
 * Surprise mathematics.
 *
 * The translation layer is only as good as this maths, so we do three things:
 *  1. compare actual vs forecast (consensus) in native units;
 *  2. standardise the surprise against the *history of the same event* (z-score)
 *     so a 30K payroll miss and a 0.1pp CPI miss are comparable;
 *  3. fall back to a tolerance band when there is not enough history yet.
 */
import type { EventDef } from "./registry.ts";

export interface HistoryStats {
  n: number;
  mean: number;
  scale: number; // robust std (MAD-based when possible)
}

export interface SurpriseResult {
  diff: number | null; // actual - forecast
  diffPrev: number | null; // actual - previous
  pct: number | null; // % difference vs forecast
  z: number | null;
  magnitude: number | null; // 0..1
  inLine: boolean;
  basis: "forecast" | "previous" | "none";
  note: string;
}

export function statsFrom(values: number[]): HistoryStats {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0, mean: 0, scale: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const deviations = v.map((x) => Math.abs(x - mean)).sort((a, b) => a - b);
  const med = deviations[Math.floor(deviations.length / 2)];
  let scale: number;
  if (n >= 8) {
    scale = Math.max(1.4826 * med, 1e-9);
    const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    scale = Math.max(scale, std * 0.6, 1e-9); // blend MAD and std, never below a sane floor
  } else {
    const std = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    scale = std;
  }
  return { n, mean, scale };
}

export function computeSurprise(
  def: EventDef,
  actual: number | null,
  forecast: number | null,
  previous: number | null,
  hist: HistoryStats,
): SurpriseResult {
  if (actual === null || !Number.isFinite(actual)) {
    return {
      diff: null,
      diffPrev: null,
      pct: null,
      z: null,
      magnitude: null,
      inLine: false,
      basis: "none",
      note: "Awaiting release",
    };
  }

  let diff: number | null = null;
  let diffPrev: number | null = null;
  let basis: SurpriseResult["basis"] = "none";
  let pct: number | null = null;

  if (forecast !== null && Number.isFinite(forecast)) {
    diff = actual - forecast;
    basis = "forecast";
    if (forecast !== 0) pct = (diff / Math.abs(forecast)) * 100;
  } else if (previous !== null && Number.isFinite(previous)) {
    diffPrev = actual - previous;
    basis = "previous";
    if (previous !== 0) pct = (diffPrev / Math.abs(previous)) * 100;
  }

  const tol = def.tolerance;
  const reference = diff ?? diffPrev;
  if (reference === null) {
    return {
      diff,
      diffPrev,
      pct,
      z: null,
      magnitude: null,
      inLine: false,
      basis: "none",
      note: "No consensus or prior to compare against",
    };
  }

  // "tolerance" is the size of a *meaningful* move for this event:
  // anything inside half of it is treated as in-line noise.
  const inLine = tol > 0 && Math.abs(reference) <= tol / 2;

  // z-score against this event's own surprise history
  let z: number | null = null;
  if (hist.n >= 6 && hist.scale > 0 && diff !== null) {
    z = (diff - hist.mean) / hist.scale;
  }

  let magnitude: number;
  if (z !== null) {
    magnitude = Math.min(1, Math.abs(z) / 1.5);
  } else if (tol > 0) {
    magnitude = Math.min(1, Math.abs(reference) / (2 * tol));
  } else {
    magnitude = Math.min(1, Math.abs(reference) / 0.5);
  }
  if (inLine) magnitude = Math.min(magnitude, 0.1); // still register, but it is a non-event

  // no consensus -> momentum proxy only, at reduced confidence
  if (basis === "previous") magnitude *= 0.6;

  const note = inLine
    ? "In line with expectations"
    : basis === "forecast"
      ? z !== null
        ? `Surprise ${reference >= 0 ? "+" : ""}${round(reference)} vs consensus (z=${z.toFixed(2)})`
        : `Surprise ${reference >= 0 ? "+" : ""}${round(reference)} vs consensus`
      : `No consensus - vs previous ${reference >= 0 ? "+" : ""}${round(reference)}`;

  return { diff, diffPrev, pct, z, magnitude: round4(magnitude), inLine, basis, note };
}

function round(n: number): number {
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
