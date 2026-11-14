/** Data-access helpers over the SQLite store. */
import { openDb } from "./db.ts";
import type { CalEvent, NewsItem, PricePoint, Bias } from "../types.ts";
import { classify, defFor } from "../engine/registry.ts";
import { etParts } from "../util/time.ts";

export interface EventRow extends CalEvent {
  dateKey: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
}

export function eventId(currency: string, title: string, ts: number): string {
  return `${currency}|${slug(title)}|${ts}`;
}

export function upsertEvent(ev: CalEvent): void {
  const db = openDb();
  const dateKey = etParts(ev.ts).dateKey;
  // remove stale rows for the same event on the same day (feed time revisions)
  db.prepare(
    `DELETE FROM events WHERE currency = ? AND title = ? AND ts >= ? AND ts < ?`,
  ).run(ev.currency, ev.title, tsOfDay(dateKey) - 1, tsOfDay(dateKey) + 2 * 86_400_000);

  db.prepare(
    `INSERT INTO events (
       id, title, canon, currency, ts, impact, forecast, forecast_raw, previous, previous_raw,
       actual, actual_raw, surprise, surprise_pct, z, magnitude, contribution, impact_score, bias, note, source, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       impact=excluded.impact, forecast=excluded.forecast, forecast_raw=excluded.forecast_raw,
       previous=excluded.previous, previous_raw=excluded.previous_raw,
       actual=COALESCE(excluded.actual, events.actual),
       actual_raw=COALESCE(NULLIF(excluded.actual_raw,''), events.actual_raw),
       canon=excluded.canon, updated_at=excluded.updated_at`,
  ).run(
    ev.id,
    ev.title,
    ev.canon,
    ev.currency,
    ev.ts,
    ev.impact,
    ev.forecast,
    ev.forecastRaw,
    ev.previous,
    ev.previousRaw,
    ev.actual,
    ev.actualRaw,
    ev.surprise,
    ev.surprisePct,
    ev.z,
    ev.magnitude,
    ev.contribution,
    ev.impactScore ?? null,
    ev.bias,
    ev.note,
    ev.source,
    Date.now(),
  );
}

function tsOfDay(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function rowToEvent(r: Record<string, unknown>): EventRow {
  const def = r.canon ? defFor(String(r.canon)) : undefined;
  return {
    id: String(r.id),
    title: String(r.title),
    canon: (r.canon as string) ?? null,
    canonLabel: def?.label ?? null,
    currency: String(r.currency),
    ts: Number(r.ts),
    impact: String(r.impact),
    forecast: r.forecast === null || r.forecast === undefined ? null : Number(r.forecast),
    forecastRaw: String(r.forecast_raw ?? ""),
    previous: r.previous === null || r.previous === undefined ? null : Number(r.previous),
    previousRaw: String(r.previous_raw ?? ""),
    actual: r.actual === null || r.actual === undefined ? null : Number(r.actual),
    actualRaw: String(r.actual_raw ?? ""),
    surprise: r.surprise === null || r.surprise === undefined ? null : Number(r.surprise),
    surpriseSign: r.surprise_sign === null || r.surprise_sign === undefined ? null : Number(r.surprise_sign),
    surprisePct: r.surprise_pct === null || r.surprise_pct === undefined ? null : Number(r.surprise_pct),
    z: r.z === null || r.z === undefined ? null : Number(r.z),
    magnitude: r.magnitude === null || r.magnitude === undefined ? null : Number(r.magnitude),
    contribution: r.contribution === null || r.contribution === undefined ? null : Number(r.contribution),
    impactScore: r.impact_score === null || r.impact_score === undefined ? null : Number(r.impact_score),
    bias: (r.bias as Bias) ?? null,
    note: (r.note as string) ?? null,
    source: String(r.source ?? "forexfactory"),
    released: r.actual !== null && r.actual !== undefined,
    dateKey: etParts(Number(r.ts)).dateKey,
  };
}

export function getEventsSince(ts: number): EventRow[] {
  const rows = openDb()
    .prepare("SELECT * FROM events WHERE ts >= ? AND currency = 'USD' ORDER BY ts")
    .all(ts) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function getAllEvents(): EventRow[] {
  const rows = openDb()
    .prepare("SELECT * FROM events WHERE currency = 'USD' ORDER BY ts")
    .all() as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function updateEventAnalysis(
  id: string,
  a: { surprise: number | null; surprisePct: number | null; surpriseSign: number | null; z: number | null; magnitude: number | null; contribution: number | null; impactScore: number | null; bias: Bias | null; note: string | null },
): void {
  openDb()
    .prepare(
      `UPDATE events SET surprise=?, surprise_pct=?, surprise_sign=?, z=?, magnitude=?, contribution=?, impact_score=?, bias=?, note=? WHERE id=?`,
    )
    .run(a.surprise, a.surprisePct, a.surpriseSign, a.z, a.magnitude, a.contribution, a.impactScore, a.bias, a.note, id);
}

export function getSurpriseDiffs(canon: string, limit = 40): number[] {
  const rows = openDb()
    .prepare(
      `SELECT diff FROM surprise_history WHERE canon = ? AND diff IS NOT NULL ORDER BY ts DESC LIMIT ?`,
    )
    .all(canon, limit) as { diff: number }[];
  return rows.map((r) => r.diff);
}

export function recordSurpriseHistory(
  canon: string,
  ts: number,
  diff: number | null,
  diffPrev: number | null,
  actual: number | null,
  forecast: number | null,
  previous: number | null,
): void {
  openDb()
    .prepare(
      `INSERT INTO surprise_history(canon, ts, diff, diff_prev, actual, forecast, previous)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(canon, ts) DO UPDATE SET diff=excluded.diff, diff_prev=excluded.diff_prev,
         actual=excluded.actual, forecast=excluded.forecast, previous=excluded.previous`,
    )
    .run(canon, ts, diff, diffPrev, actual, forecast, previous);
}

export function saveNews(items: NewsItem[]): void {
  const db = openDb();
  const stmt = db.prepare(
    `INSERT INTO news(id, ts, title, link, source, tier, relevance, tilt, tags, summary)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, tier=excluded.tier, relevance=excluded.relevance,
       tilt=excluded.tilt, tags=excluded.tags, summary=excluded.summary`,
  );
  for (const n of items) {
    stmt.run(n.id, n.ts, n.title, n.link, n.source, n.tier, n.relevance, n.tilt, JSON.stringify(n.tags), n.summary);
  }
}

export function getNews(sinceTs: number, limit = 120): NewsItem[] {
  const rows = openDb()
    .prepare("SELECT * FROM news WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
    .all(sinceTs, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    ts: Number(r.ts),
    title: String(r.title),
    link: String(r.link),
    source: String(r.source),
    tier: Number(r.tier),
    relevance: Number(r.relevance),
    tilt: Number(r.tilt),
    tags: JSON.parse(String(r.tags ?? "[]")),
    summary: String(r.summary ?? ""),
  }));
}

export function savePrice(p: PricePoint): void {
  openDb()
    .prepare("INSERT INTO price(symbol, ts, price, source) VALUES (?,?,?,?) ON CONFLICT(symbol, ts) DO UPDATE SET price=excluded.price, source=excluded.source")
    .run(p.symbol, p.ts, p.price, p.source);
}

export function getPrices(sinceTs: number, symbol: string | null = null, limit = 5000): PricePoint[] {
  const sql = symbol
    ? "SELECT symbol, ts, price, source FROM price WHERE ts >= ? AND symbol = ? ORDER BY ts LIMIT ?"
    : "SELECT symbol, ts, price, source FROM price WHERE ts >= ? ORDER BY ts LIMIT ?";
  const params = symbol ? [sinceTs, symbol, limit] : [sinceTs, limit];
  const rows = openDb()
    .prepare(sql)
    .all(...params) as { symbol: string; ts: number; price: number; source: string }[];
  return rows.map((r) => ({ symbol: r.symbol, ts: r.ts, price: r.price, source: r.source }));
}

export function logCall(c: {
  ts: number;
  canon: string | null;
  eventTs: number | null;
  bias: Bias;
  confidence: number;
  stance: string;
  regime: string;
  score: number;
  detail: unknown;
}): void {
  openDb()
    .prepare(
      "INSERT INTO calls(ts, canon, event_ts, bias, confidence, stance, regime, score, detail) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(c.ts, c.canon, c.eventTs, c.bias, c.confidence, c.stance, c.regime, c.score, JSON.stringify(c.detail));
}

export interface CallRow {
  id: number;
  ts: number;
  canon: string | null;
  event_ts: number | null;
  bias: Bias;
  confidence: number;
  stance: string;
  regime: string;
  score: number;
  detail: string;
}

export function getCalls(limit = 200): CallRow[] {
  return openDb()
    .prepare("SELECT * FROM calls ORDER BY ts DESC LIMIT ?")
    .all(limit) as CallRow[];
}

export function getLatestCallForEvent(canon: string, eventTs: number): CallRow | undefined {
  return openDb()
    .prepare("SELECT * FROM calls WHERE canon = ? AND event_ts = ? ORDER BY ts DESC LIMIT 1")
    .get(canon, eventTs) as CallRow | undefined;
}

export function saveOutcome(o: {
  canon: string;
  eventTs: number;
  horizon: string;
  move: number | null;
  hit: number | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO outcomes(canon, event_ts, horizon, move, hit, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(canon, event_ts, horizon) DO UPDATE SET move=excluded.move, hit=excluded.hit`,
    )
    .run(o.canon, o.eventTs, o.horizon, o.move, o.hit, Date.now());
}

export function getOutcomes(): {
  canon: string;
  event_ts: number;
  horizon: string;
  move: number | null;
  hit: number | null;
}[] {
  return openDb().prepare("SELECT canon, event_ts, horizon, move, hit FROM outcomes").all() as {
    canon: string;
    event_ts: number;
    horizon: string;
    move: number | null;
    hit: number | null;
  }[];
}

export function addJournal(j: {
  ts: number;
  canon: string | null;
  bias: string;
  instrument: string;
  note: string;
  result: number | null;
}): void {
  openDb()
    .prepare("INSERT INTO journal(ts, canon, bias, instrument, note, result) VALUES (?,?,?,?,?,?)")
    .run(j.ts, j.canon, j.bias, j.instrument, j.note, j.result);
}

export function getJournal(limit = 100): {
  id: number;
  ts: number;
  canon: string | null;
  bias: string;
  instrument: string;
  note: string;
  result: number | null;
}[] {
  return openDb()
    .prepare("SELECT * FROM journal ORDER BY ts DESC LIMIT ?")
    .all(limit) as {
    id: number;
    ts: number;
    canon: string | null;
    bias: string;
    instrument: string;
    note: string;
    result: number | null;
  }[];
}

export { classify };
