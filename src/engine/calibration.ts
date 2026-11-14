/**
 * Calibration: the feedback loop that keeps the translation honest.
 *
 * Every scored call (bias vs realised DXY move) becomes evidence for the event type.
 * Event types that historically mislead us get their weight shrunk; event types that
 * have been reliable get a small boost. The shrink is Bayesian - a single lucky call
 * moves nothing, ten consistent calls move the weight.
 */

export interface OutcomeRow {
  canon: string;
  horizon: string;
  hit: number | null;
}

export interface Calibration {
  canon: string;
  n: number;
  hits: number;
  hitRate: number;
  multiplier: number;
}

const MIN_SAMPLES = 5;
const MAX_WEIGHT = 1.35;
const MIN_WEIGHT = 0.65;

export function computeCalibration(rows: OutcomeRow[]): Map<string, Calibration> {
  const acc = new Map<string, { n: number; hits: number }>();
  for (const r of rows) {
    if (r.hit === null || r.hit === undefined) continue;
    const cur = acc.get(r.canon) ?? { n: 0, hits: 0 };
    cur.n++;
    cur.hits += r.hit;
    acc.set(r.canon, cur);
  }

  const out = new Map<string, Calibration>();
  for (const [canon, v] of acc) {
    const hitRate = v.n ? v.hits / v.n : 0.5;
    const shrink = v.n < MIN_SAMPLES ? 0 : Math.min(1, v.n / (MIN_SAMPLES * 2));
    const multiplier = Math.max(
      MIN_WEIGHT,
      Math.min(MAX_WEIGHT, 1 + (hitRate - 0.5) * 2 * shrink),
    );
    out.set(canon, { canon, n: v.n, hits: v.hits, hitRate, multiplier: Math.round(multiplier * 1000) / 1000 });
  }
  return out;
}
