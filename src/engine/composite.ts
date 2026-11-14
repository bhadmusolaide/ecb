/**
 * The translator: releases + news + market state  ->  DXY bias.
 *
 * Three outputs, always kept separate (they answer different questions):
 *   bias   - where DXY is biased (Bullish / Bearish / Neutral)
 *   stance - what the Fed is saying (Hawkish / Dovish / Neutral)
 *   regime - whether to expect clean follow-through (Trending) or whipsaw (Choppy)
 */
import type { CalEvent, Bias, Stance, Regime, NewsItem, PricePoint } from "../types.ts";
import { defFor } from "./registry.ts";
import { CONFIG } from "../config.ts";

export interface EngineInput {
  now: number;
  events: CalEvent[];
  news: NewsItem[];
  prices: PricePoint[];
  /** lexicon score per event id for qualitative releases (statement / presser / speeches) */
  lexScores?: Map<string, number>;
  /** per-canonical-event weight multipliers learned from the track record */
  calibration?: Map<string, number>;
}

export interface Contribution {
  canon: string;
  title: string;
  ts: number;
  contribution: number;
  bias: Bias;
  weight: number;
  magnitude: number | null;
  note: string;
}

export interface EngineOutput {
  bias: Bias;
  stance: Stance;
  regime: Regime;
  score: number;
  confidence: number;
  categoryScores: Record<string, number>;
  contributions: Contribution[];
  drivers: string[];
  conflicts: string[];
  nextEvent: CalEvent | null;
  msToNext: number;
  eventRisk: boolean;
  price: PricePoint | null;
  priceChange1h: number | null;
  realizedVol1h: number | null;
  newsTilt: number;
}

const BIAS_THRESHOLD = 0.22;

export function runEngine(input: EngineInput): EngineOutput {
  const { now, events, news, prices, lexScores } = input;

  const contributions: Contribution[] = [];
  const categoryScores: Record<string, number> = {
    policy: 0,
    inflation: 0,
    labor: 0,
    growth: 0,
    energy: 0,
  };

  for (const ev of events) {
    const def = ev.canon ? defFor(ev.canon) : undefined;
    if (!def) continue;
    if (ev.ts > now + 60_000) continue; // not released yet
    const ageH = Math.max(0, (now - ev.ts) / 3_600_000);
    if (ageH > CONFIG.eventInfluenceHours) continue;
    const decay = Math.exp(-ageH / 8);
    const cal = input.calibration?.get(def.key) ?? 1;

    let raw = 0;
    if (ev.released && ev.magnitude !== null && ev.magnitude !== undefined) {
      // sign convention (higher = hawkish?) x direction of the surprise x magnitude x calibration
      const dir = ev.surpriseSign ?? 0;
      raw = def.sign * def.weight * ev.magnitude * dir * cal;
    } else if (def.qualitative) {
      const lex = lexScores?.get(ev.id) ?? 0;
      if (lex !== 0) raw = def.sign * def.weight * Math.min(1, Math.abs(lex) / 3) * 0.5 * cal;
    }
    if (raw === 0) continue;

    const contribution = raw * decay;
    categoryScores[def.category] = (categoryScores[def.category] ?? 0) + contribution;
    contributions.push({
      canon: def.key,
      title: ev.title,
      ts: ev.ts,
      contribution: round4(contribution),
      bias: contribution > 0 ? "Bullish" : "Bearish",
      weight: def.weight,
      magnitude: ev.magnitude,
      note: ev.note ?? "",
    });
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const score = round4(contributions.reduce((a, c) => a + c.contribution, 0));

  // ---------------- bias ----------------
  let bias: Bias = "Neutral";
  if (score >= BIAS_THRESHOLD) bias = "Bullish";
  else if (score <= -BIAS_THRESHOLD) bias = "Bearish";

  // ---------------- stance (policy read) ----------------
  const stanceScore =
    categoryScores.policy + 0.6 * categoryScores.inflation + 0.4 * categoryScores.labor;
  let stance: Stance = "Neutral";
  if (stanceScore >= 0.22) stance = "Hawkish";
  else if (stanceScore <= -0.22) stance = "Dovish";

  // ---------------- upcoming event risk ----------------
  const upcoming = events
    .filter((e) => e.ts > now && e.ts - now < 26 * 3_600_000)
    .sort((a, b) => a.ts - b.ts);
  const nextEvent = upcoming.find((e) => e.impact === "High") ?? upcoming[0] ?? null;
  const msToNext = nextEvent ? nextEvent.ts - now : Number.POSITIVE_INFINITY;
  const eventRisk = Number.isFinite(msToNext) && msToNext <= 30 * 60_000;

  // ---------------- news tilt ----------------
  const newsTilt = aggregateNewsTilt(news, now);

  // ---------------- conflicts ----------------
  const conflicts: string[] = [];
  const infl = categoryScores.inflation;
  const growth = categoryScores.growth + categoryScores.labor;
  if (Math.sign(infl) !== Math.sign(growth) && Math.abs(infl) > 0.12 && Math.abs(growth) > 0.12) {
    conflicts.push(
      `Inflation impulse (${fmtSigned(infl)}) fights the growth/labour impulse (${fmtSigned(growth)}) - stagflation-style two-way risk`,
    );
  }
  if (newsTilt !== 0 && Math.sign(newsTilt) !== Math.sign(score) && Math.abs(score) > 0.15) {
    conflicts.push(
      `News/geopolitics lean ${newsTilt > 0 ? "USD-supportive" : "USD-negative"} against the calendar impulse`,
    );
  }

  // ---------------- price & volatility ----------------
  const price = prices.length ? prices[prices.length - 1] : null;
  const priceChange1h = changeOver(prices, now, 3_600_000);
  const realizedVol1h = realizedVol(prices, now, 3_600_000);

  // ---------------- regime ----------------
  let regime: Regime = "Trending";
  if (eventRisk) {
    regime = "Choppy";
    conflicts.push(
      `High-impact release inside 30 minutes (${nextEvent?.title ?? "event"}) - binary risk, wait for the print`,
    );
  }
  if (Math.abs(score) < 0.15) {
    regime = "Choppy";
  }
  if (conflicts.length > 0 && Math.abs(score) < 0.35) {
    regime = "Choppy";
  }
  if (realizedVol1h !== null && realizedVol1h > 0.0035) {
    regime = "Choppy";
    conflicts.push(`DXY realised volatility elevated (${(realizedVol1h * 100).toFixed(2)}% per hour)`);
  }

  // ---------------- confidence ----------------
  let confidence: number;
  if (bias === "Neutral") {
    // "Neutral" means there is no edge - conviction in a neutral call stays low.
    confidence = 0.1 + 0.25 * (1 - Math.min(1, Math.abs(score) / BIAS_THRESHOLD));
  } else {
    confidence = 0.15 + 0.85 * Math.min(1, Math.abs(score) / 0.7);
  }
  if (conflicts.length > 0) confidence *= 0.85;
  if (eventRisk) confidence *= 0.8;
  if (contributions.length === 0) confidence = Math.min(confidence, 0.3);
  confidence = Math.round(Math.max(0.05, Math.min(0.97, confidence)) * 100) / 100;

  // ---------------- drivers ----------------
  const drivers = contributions.filter((c) => Math.abs(c.contribution) >= 0.02).slice(0, 4).map((c) => {
    const arrow = c.contribution > 0 ? "USD+" : "USD-";
    const mag = c.magnitude !== null ? ` (${(c.magnitude * 100).toFixed(0)}% of max impact)` : "";
    return `${c.title}: ${arrow} ${fmtSigned(c.contribution)}${mag}`;
  });

  return {
    bias,
    stance,
    regime,
    score,
    confidence,
    categoryScores,
    contributions,
    drivers,
    conflicts,
    nextEvent,
    msToNext,
    eventRisk,
    price,
    priceChange1h,
    realizedVol1h,
    newsTilt,
  };
}

export function aggregateNewsTilt(news: NewsItem[], now: number): number {
  let total = 0;
  for (const n of news) {
    const ageH = (now - n.ts) / 3_600_000;
    if (ageH < 0 || ageH > 36) continue;
    const decay = ageH < 6 ? 1 : ageH < 24 ? 0.5 : 0.2;
    total += n.tilt * n.relevance * decay * (n.tier === 1 ? 1.5 : n.tier === 2 ? 1 : 0.5);
  }
  const squash = Math.tanh(total / 2.5);
  return Math.round(squash * 1000) / 1000;
}

function changeOver(prices: PricePoint[], now: number, windowMs: number): number | null {
  if (prices.length < 2) return null;
  const target = now - windowMs;
  let base: PricePoint | null = null;
  for (const p of prices) {
    if (p.ts <= target) base = p;
    else break;
  }
  const last = prices[prices.length - 1];
  if (!base) base = prices[0];
  if (!base || base.price === 0) return null;
  return (last.price - base.price) / base.price;
}

function realizedVol(prices: PricePoint[], now: number, windowMs: number): number | null {
  const inWin = prices.filter((p) => p.ts >= now - windowMs);
  if (inWin.length < 5) return null;
  const rets: number[] = [];
  for (let i = 1; i < inWin.length; i++) {
    const a = inWin[i - 1].price;
    const b = inWin[i].price;
    if (a > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 4) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

export function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
