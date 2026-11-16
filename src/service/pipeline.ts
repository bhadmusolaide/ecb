/**
 * The pipeline: fetch -> merge -> analyse -> persist -> state.
 */
import { fetchFeedEvents, fetchWeek, rowTimestamp } from "../providers/calendar/forexfactory.ts";
import type { ScrapedRow, RawFeedEvent } from "../providers/calendar/forexfactory.ts";
import { fetchInvestingCalendar } from "../providers/calendar/investing.ts";
import type { InvestingRow } from "../providers/calendar/investing.ts";
import { fetchFedDocs } from "../providers/calendar/fed.ts";
import type { FedDoc } from "../providers/calendar/fed.ts";
import { fetchAllNews } from "../providers/news/rss.ts";
import { getQuote, getCandles, getAllQuotes, getAllCandles, SYMBOL_KEYS } from "../providers/price/index.ts";
import { classify, defFor } from "../engine/registry.ts";
import type { EventDef } from "../engine/registry.ts";
import { computeSurprise, statsFrom } from "../engine/surprise.ts";
import { runEngine } from "../engine/composite.ts";
import { computeCalibration } from "../engine/calibration.ts";
import type { EngineOutput } from "../engine/composite.ts";
import { buildPrePlan, biasFromActual } from "../engine/preplan.ts";
import type { PrePlan } from "../engine/preplan.ts";
import { stanceFromScore } from "../engine/lexicon.ts";
import { readFedTone, readHeadline, llmAvailable } from "../llm/analyst.ts";
import * as q from "../store/queries.ts";
const savePrice = q.savePrice;
import { getKv, setKv } from "../store/db.ts";
import { etParts, sessionFor, sessionMeta, fmtEtFull, humanDuration } from "../util/time.ts";
import { parseNumber } from "../util/numbers.ts";
import type { CalEvent, NewsItem, PricePoint, Bias } from "../types.ts";

const CACHE_KEY = "lexDocs";

/** Last capitalised word of a title - used to match a Fed press release to a calendar speech. */
function lastName(title: string): string {
  const words = title.replace(/[^A-Za-z .'-]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.length > 2 && /^[A-Z]/.test(w) && !/Speaks|Statement|Minutes|Remarks|Testimony|Speech/i.test(w)) return w;
  }
  return "";
}

export interface LexEntry {
  eventId: string;
  score: number;
  terms: string[];
  stance: string;
  summary?: string;
}

/** ------------------------------------------------------------------ calendar */

export async function refreshCalendar(now = Date.now()): Promise<{ added: number; updated: number }> {
  // 1) website scrape: this week + next week (schedule + forecast + previous + actual)
  const rows: ScrapedRow[] = [];
  for (const week of ["this", "next"] as const) {
    try {
      rows.push(...(await fetchWeek(week)));
    } catch (err) {
      console.warn(`[calendar] week=${week} scrape failed:`, (err as Error).message);
    }
  }

  // 2) public JSON feed as a supplement (current week) and as a fallback
  const feed = await fetchFeedEvents();

  // 3) fallback: when both ForexFactory sources are blocked, try Investing.com
  if (rows.length === 0 && feed.length === 0) {
    const ir = await fetchInvestingCalendar();
    for (const r of ir) rows.push(r);
  }

  const jsonByKey = new Map<string, RawFeedEvent>();
  for (const f of feed) {
    const ts = Date.parse(f.date);
    if (!Number.isFinite(ts)) continue;
    const p = etParts(ts);
    jsonByKey.set(`${f.country}|${f.title}|${p.dateKey}`, f);
  }

  const seenRows = new Set<string>();
  const existing = new Set(q.getAllEvents().map((e) => e.id));
  let added = 0;
  let updated = 0;

  const upsert = (
    title: string,
    currency: string,
    ts: number,
    impact: string,
    forecastRaw: string,
    previousRaw: string,
    actualRaw: string,
    source: string,
  ) => {
    const def = classify(title);
    const ev: CalEvent = {
      id: q.eventId(currency, title, ts),
      title,
      canon: def?.key ?? null,
      canonLabel: def?.label ?? null,
      currency,
      ts,
      impact,
      forecast: parseNumber(forecastRaw)?.value ?? null,
      forecastRaw,
      previous: parseNumber(previousRaw)?.value ?? null,
      previousRaw,
      actual: parseNumber(actualRaw)?.value ?? null,
      actualRaw,
      surprise: null,
      surprisePct: null,
      z: null,
      surpriseSign: null,
      magnitude: null,
      contribution: null,
      impactScore: null,
      bias: null,
      note: null,
      source,
      released: Boolean(actualRaw && parseNumber(actualRaw)),
    };
    q.upsertEvent(ev);
    if (existing.has(ev.id)) updated++;
    else added++;
  };

  for (const row of rows) {
    if (row.currency !== "USD") continue;
    const key = `${row.currency}|${row.title}|${row.dateKey}|${row.time}`;
    if (seenRows.has(key)) continue;
    seenRows.add(key);

    const ts = rowTimestamp(row);
    if (!Number.isFinite(ts)) continue;

    const json = jsonByKey.get(`${row.currency}|${row.title}|${row.dateKey}`);
    upsert(
      row.title,
      row.currency,
      ts,
      row.impact,
      row.forecastRaw || json?.forecast || "",
      row.previousRaw || json?.previous || "",
      row.actualRaw,
      "forexfactory",
    );
  }

  // JSON-only events (HTML blocked or row not parsed) still give us the schedule
  for (const f of feed) {
    if (f.country !== "USD") continue;
    const ts = Date.parse(f.date);
    if (!Number.isFinite(ts)) continue;
    const p = etParts(ts);
    const key = `${f.country}|${f.title}|${p.dateKey}`;
    if (seenRows.has(key)) continue;
    if (q.getAllEvents().some((e) => e.title === f.title && e.currency === f.country && Math.abs(e.ts - ts) < 3_600_000)) {
      continue;
    }
    seenRows.add(key);
    upsert(f.title, f.country, ts, f.impact, f.forecast, f.previous, "", "forexfactory-json");
  }

  await refreshLexScores(now);
  analyzeEvents(now);
  return { added, updated };
}

/** Attach hawkish/dovish lexicon scores (and optional LLM reads) to qualitative Fed events. */
async function refreshLexScores(now: number): Promise<void> {
  const docs = await fetchFedDocs().catch(() => [] as FedDoc[]);
  if (docs.length === 0) return;

  const events = q.getAllEvents().filter((e) => e.canon && ["fomc_statement", "fomc_minutes", "fed_speech", "fomc_press_conference"].includes(e.canon));
  const entries: LexEntry[] = getKv<LexEntry[]>(CACHE_KEY) ?? [];
  const byEvent = new Map(entries.map((e) => [e.eventId, e]));

  const llm = llmAvailable();

  for (const doc of docs) {
    const surname = lastName(doc.title);
    const target = events.find((ev) => {
      const dt = Math.abs(ev.ts - doc.ts);
      if (doc.kind === "statement") return ev.canon === "fomc_statement" && dt < 14 * 3_600_000;
      if (doc.kind === "minutes") return ev.canon === "fomc_minutes" && dt < 14 * 3_600_000;
      if (doc.kind === "speech") {
        if (dt > 30 * 3_600_000) return false;
        if (!surname) return false;
        return ev.title.toLowerCase().includes(surname.toLowerCase());
      }
      return false;
    });
    if (!target) continue;

    const cached = byEvent.get(target.id);
    if (cached && cached.summary) continue;

    const stance = stanceFromScore(doc.lex);
    let score = doc.lex;
    let summary: string | undefined;

    if (llm.enabled && doc.text.length > 400) {
      const read = await readFedTone(doc.text, doc.title);
      if (read) {
        score = read.score;
        summary = read.summary;
      }
    }

    const entry: LexEntry = {
      eventId: target.id,
      score: Math.max(-3, Math.min(3, score)),
      terms: doc.lexTerms.slice(0, 6),
      stance,
      summary,
    };
    entries.push(entry);
    byEvent.set(target.id, entry);
  }

  setKv(CACHE_KEY, entries);
}

/** ------------------------------------------------------------------ analysis */

/** Compute surprise, z-score, magnitude and contribution for every released event. */
export function analyzeEvents(now = Date.now()): void {
  const events = q.getAllEvents();
  for (const ev of events) {
    if (!ev.canon || !ev.released || ev.actual === null) continue;
    const def = defFor(ev.canon);
    if (!def) continue;

    const hist = statsFrom(q.getSurpriseDiffs(ev.canon));
    const sur = computeSurprise(def, ev.actual, ev.forecast, ev.previous, hist);

    const ageH = Math.max(0, (now - ev.ts) / 3_600_000);
    const decay = Math.exp(-ageH / 8);
    const rawSurprise = sur.diff ?? sur.diffPrev;
    const surpriseSign = rawSurprise === null || rawSurprise === undefined ? 0 : Math.sign(rawSurprise);
    const impactScore =
      sur.magnitude === null
        ? null
        : Math.round(def.sign * def.weight * sur.magnitude * surpriseSign * 10000) / 10000;
    const contribution =
      impactScore === null ? null : Math.round(impactScore * decay * 10000) / 10000;

    const perEvent = biasFromActual(ev, ev.actual);

    q.updateEventAnalysis(ev.id, {
      surprise: sur.diff,
      surprisePct: sur.pct,
      surpriseSign,
      z: sur.z,
      magnitude: sur.magnitude,
      contribution,
      impactScore,
      bias: perEvent.bias,
      note: sur.note,
    });

    q.recordSurpriseHistory(
      ev.canon,
      ev.ts,
      sur.diff,
      sur.diffPrev,
      ev.actual,
      ev.forecast,
      ev.previous,
    );
  }
}

/* ------------------------------------------------------------------ news */

export async function refreshNews(now = Date.now()): Promise<number> {
  const items = await fetchAllNews();
  const llm = llmAvailable();

  if (llm.enabled) {
    // Only ask the model about headlines the rules could not place.
    const ambiguous = items
      .filter((n) => n.tilt === 0 && n.relevance >= 0.33 && n.tier <= 2)
      .slice(0, 5);
    for (const n of ambiguous) {
      const read = await readHeadline(n.title, n.summary);
      if (read) {
        n.tilt = read.tilt;
        n.tier = Math.min(n.tier, read.tier);
        n.relevance = Math.max(n.relevance, read.relevance);
        n.tags = [...n.tags, `LLM:${read.reason}`];
      }
    }
  }

  q.saveNews(items);
  return items.length;
}

/* ------------------------------------------------------------------ price */

/** Seed the price history from the provider (needs a key) so replay / self-scoring has data. */
export async function seedPriceHistory(): Promise<number> {
  // Only seed when we are thin on history in the last day.
  const recent = q.getPrices(Date.now() - 86_400_000, 5000);
  if (recent.length >= 50) return 0;
  const all = await getAllCandles("5min", 500).catch(() => new Map<string, Candle[]>());
  let total = 0;
  for (const [key, candles] of all) {
    for (const c of candles) savePrice({ symbol: key, ts: c.ts, price: c.price, source: `twelvedata:candles:${key}` });
    total += candles.length;
  }
  return total;
}

export async function refreshPrices(now = Date.now()): Promise<Map<string, PricePoint>> {
  const quotes = await getAllQuotes();
  const out = new Map<string, PricePoint>();
  for (const [key, q] of quotes) {
    const p: PricePoint = { symbol: key, ts: q.ts || now, price: q.price, source: q.source };
    savePrice(p);
    out.set(key, p);
  }
  // Feed down: keep serving the last real print for any symbol we couldn't fetch.
  for (const key of SYMBOL_KEYS) {
    if (out.has(key)) continue;
    const last = q.getPrices(now - 6 * 3_600_000, key, 1);
    if (last.length) out.set(key, last[last.length - 1]);
  }
  return out;
}

/* ------------------------------------------------------------------ state */

export interface NowState {
  now: number;
  etTime: string;
  etDate: string;
  session: { name: string; label: string; start: string; end: string; note: string };
  bias: Bias;
  stance: string;
  regime: string;
  score: number;
  confidence: number;
  drivers: string[];
  conflicts: string[];
  categoryScores: Record<string, number>;
  contributions: ReturnType<typeof runEngine>["contributions"];
  newsTilt: number;
  calibration: { canon: string; n: number; hits: number; hitRate: number; multiplier: number }[];
  prices: Record<string, { price: number; source: string; change1h: number | null; vol1h: number | null }>;
  dxyHistory: { ts: number; price: number }[];
  nextEvent: (CalEvent & { preplan: PrePlan | null }) | null;
  context: string;
  msToNext: number;
  countdown: string;
  events: ReturnType<typeof q.getEventsSince>;
  news: NewsItem[];
  stats: ReturnType<typeof computeStats>;
  sources: { calendar: string; price: Record<string, string>; news: string; llm: string };
  updatedAt: number;
}

export function buildState(now = Date.now()): NowState {
  const events = q.getEventsSince(now - 72 * 3_600_000);
  const news = q.getNews(now - 48 * 3_600_000, 120);
  const dxyPrices = q.getPrices(now - 24 * 3_600_000, "DXY", 5000);
  const allPrices = q.getPrices(now - 24 * 3_600_000, null, 5000);

  const lexEntries = getKv<LexEntry[]>(CACHE_KEY) ?? [];
  const lexScores = new Map<string, number>();
  const lexByEvent = new Map(lexEntries.map((e) => [e.eventId, e]));
  for (const e of lexEntries) lexScores.set(e.eventId, e.score);

  // enrich event notes with the Fed read
  for (const ev of events) {
    const le = lexByEvent.get(ev.id);
    if (le) {
      ev.note = le.summary
        ? `${le.stance}: ${le.summary}`
        : `${le.stance} (${le.terms.slice(0, 3).join(", ")})`;
    }
  }

  const calibration = computeCalibration(
    q.getOutcomes().map((o) => ({ canon: o.canon, horizon: o.horizon, hit: o.hit })),
  );
  const engine: EngineOutput = runEngine({
    now,
    events,
    news,
    prices: dxyPrices,
    lexScores,
    calibration: new Map([...calibration.entries()].map(([k, v]) => [k, v.multiplier])),
  });
  const session = sessionFor(now);
  const meta = sessionMeta(session);

  const nextRaw = engine.nextEvent;
  const preplan = nextRaw ? buildPrePlan(nextRaw) : null;
  const nextEvent = nextRaw ? { ...nextRaw, preplan } : null;

  // Build per-symbol price info from the engine's DXY price + change/vol,
  // and fall back to the last stored price for non-DXY symbols.
  const dxyPrice = engine.price;
  const pricesBySymbol = new Map<string, { ts: number; price: number; source: string }>();
  for (const p of allPrices) {
    if (!pricesBySymbol.has(p.symbol) || p.ts > pricesBySymbol.get(p.symbol)!.ts) {
      pricesBySymbol.set(p.symbol, { ts: p.ts, price: p.price, source: p.source });
    }
  }

  const prices: Record<string, { price: number; source: string; change1h: number | null; vol1h: number | null }> = {};
  for (const key of SYMBOL_KEYS) {
    const stored = pricesBySymbol.get(key);
    if (key === "DXY" && dxyPrice) {
      prices[key] = {
        price: dxyPrice.price,
        source: dxyPrice.source,
        change1h: engine.priceChange1h,
        vol1h: engine.realizedVol1h,
      };
    } else if (stored) {
      prices[key] = {
        price: stored.price,
        source: stored.source,
        change1h: null,
        vol1h: null,
      };
    } else {
      prices[key] = { price: 0, source: "unavailable", change1h: null, vol1h: null };
    }
  }

  return {
    now,
    etTime: fmtEtFull(now),
    etDate: etParts(now).dateKey,
    session: { name: meta.name, label: meta.label, start: meta.start, end: meta.end, note: meta.note },
    bias: engine.bias,
    stance: engine.stance,
    regime: engine.regime,
    score: engine.score,
    confidence: engine.confidence,
    drivers: engine.drivers,
    conflicts: engine.conflicts,
    categoryScores: engine.categoryScores,
    contributions: engine.contributions,
    newsTilt: engine.newsTilt,
    calibration: [...calibration.values()].sort((a, b) => b.n - a.n),
    prices,
    dxyHistory: dxyPrices.slice(-120).map((p) => ({ ts: p.ts, price: p.price })),
    nextEvent,
    context: buildContext({ now, engine, meta, nextEvent }),
    msToNext: engine.msToNext,
    countdown: Number.isFinite(engine.msToNext) ? humanDuration(engine.msToNext) : "—",
    events,
    news,
    stats: computeStats(),
    sources: {
      calendar: "forexfactory",
      price: Object.fromEntries([...pricesBySymbol.entries()].map(([k, v]) => [k, v.source])),
      news: "rss",
      llm: llmAvailable().enabled ? llmAvailable().model : "off (rules only)",
    },
    updatedAt: Date.now(),
  };
}

/** One-line session context: what the market is trading right now and why. */
function buildContext(args: {
  now: number;
  engine: EngineOutput;
  meta: { label: string; note: string };
  nextEvent: (CalEvent & { preplan: PrePlan | null }) | null;
}): string {
  const { now, engine, meta, nextEvent } = args;
  const parts: string[] = [];

  parts.push(`${meta.label} session (${meta.note}).`);

  if (engine.nextEvent) {
    const mins = Math.max(0, Math.round((engine.nextEvent.ts - now) / 60000));
    parts.push(
      mins < 60
        ? `Next catalyst: ${engine.nextEvent.title} in ${mins} min - binary risk, size down.`
        : `Next catalyst: ${engine.nextEvent.title} in ${Math.round(mins / 60)}h.`,
    );
  } else {
    parts.push("No USD catalyst on the feed within 26h - flow and geopolitics only.");
  }

  if (engine.newsTilt > 0.15) parts.push("News flow is leaning USD-supportive.");
  else if (engine.newsTilt < -0.15) parts.push("News flow is leaning USD-negative.");
  else parts.push("News flow is not leaning either way.");

  if (engine.conflicts.length > 0) parts.push("Signals conflict - treat as choppy until they resolve.");
  else if (engine.bias !== "Neutral") {
    parts.push(`Impulse is ${engine.bias.toLowerCase()} with ${Math.round(engine.confidence * 100)}% conviction.`);
  }

  return parts.join(" ");
}

/* ------------------------------------------------------------------ replay */

/**
 * Replay: what would the engine have said at the moment of each past release,
 * and did the DXY agree? This is the fastest way to audit the translation layer.
 */
export interface ReplayRow {
  ts: number;
  title: string;
  canon: string | null;
  actual: string;
  forecast: string;
  bias: Bias;
  contribution: number;
  move1h: number | null;
  hit: number | null;
}

export function replay(days = 10): ReplayRow[] {
  const now = Date.now();
  const from = now - days * 86_400_000;
  const events = q.getEventsSince(from).filter((e) => e.released && e.canon);
  const prices = q.getPrices(from - 86_400_000, "DXY", 50000);

  return events
    .map((ev) => {
      const base = priceNear(prices, ev.ts, 20 * 60_000);
      const after = priceNear(prices, ev.ts + 3_600_000, 30 * 60_000);
      const move = base !== null && after !== null ? (after - base) / base : null;
      let hit: number | null = null;
      if (move !== null && ev.bias && ev.bias !== "Neutral") {
        hit = ev.bias === "Bullish" ? (move > 0.0002 ? 1 : 0) : move < -0.0002 ? 1 : 0;
      }
      return {
        ts: ev.ts,
        title: ev.title,
        canon: ev.canon,
        actual: ev.actualRaw,
        forecast: ev.forecastRaw,
        bias: ev.bias ?? "Neutral",
        contribution: ev.impactScore ?? ev.contribution ?? 0,
        move1h: move,
        hit,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

function priceNear(prices: PricePoint[], target: number, tolerance: number): number | null {
  let best: PricePoint | null = null;
  let bestDelta = Infinity;
  for (const p of prices) {
    const d = Math.abs(p.ts - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  if (!best || bestDelta > tolerance) return null;
  return best.price;
}

/* ------------------------------------------------------------------ self scoring */

export interface Stats {
  calls: number;
  scored: number;
  hitRate: number | null;
  byEvent: { canon: string; n: number; hits: number; rate: number }[];
  byHorizon: { horizon: string; n: number; hits: number; rate: number }[];
}

export function computeStats(): Stats {
  const calls = q.getCalls(500);
  const outcomes = q.getOutcomes();
  const byEventMap = new Map<string, { n: number; hits: number }>();
  const byHorizonMap = new Map<string, { n: number; hits: number }>();

  for (const o of outcomes) {
    if (o.hit === null || o.hit === undefined) continue;
    const e = byEventMap.get(o.canon) ?? { n: 0, hits: 0 };
    e.n++;
    e.hits += o.hit;
    byEventMap.set(o.canon, e);
    const h = byHorizonMap.get(o.horizon) ?? { n: 0, hits: 0 };
    h.n++;
    h.hits += o.hit;
    byHorizonMap.set(o.horizon, h);
  }

  const total = [...byEventMap.values()].reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits }), { n: 0, hits: 0 });

  return {
    calls: calls.length,
    scored: total.n,
    hitRate: total.n > 0 ? Math.round((total.hits / total.n) * 100) / 100 : null,
    byEvent: [...byEventMap.entries()]
      .map(([canon, v]) => ({ canon, n: v.n, hits: v.hits, rate: v.n ? Math.round((v.hits / v.n) * 100) / 100 : 0 }))
      .sort((a, b) => b.n - a.n),
    byHorizon: [...byHorizonMap.entries()].map(([horizon, v]) => ({
      horizon,
      n: v.n,
      hits: v.hits,
      rate: v.n ? Math.round((v.hits / v.n) * 100) / 100 : 0,
    })),
  };
}

/** Log a bias call the first time we see a material release. */
export function logNewCalls(now = Date.now()): void {
  const events = q.getEventsSince(now - 48 * 3_600_000);
  for (const ev of events) {
    if (!ev.canon || !ev.released || !ev.bias) continue;
    if (ev.contribution === null || Math.abs(ev.contribution) < 0.05) continue;
    if (q.getLatestCallForEvent(ev.canon, ev.ts)) continue;
    q.logCall({
      ts: now,
      canon: ev.canon,
      eventTs: ev.ts,
      bias: ev.bias,
      confidence: Math.min(0.95, Math.abs(ev.contribution)),
      stance: ev.bias === "Bullish" ? "Hawkish" : "Dovish",
      regime: "Neutral",
      score: ev.contribution,
      detail: { title: ev.title, actual: ev.actual, forecast: ev.forecast, previous: ev.previous },
    });
  }
}

/** Score past calls against the realised DXY move. */
export function updateOutcomes(now = Date.now()): void {
  const prices = q.getPrices(now - 72 * 3_600_000, "DXY", 20000);
  if (prices.length < 3) return;
  const calls = q.getCalls(500).filter((c) => c.event_ts);

  const horizons: [string, number][] = [
    ["30m", 30 * 60_000],
    ["1h", 3_600_000],
    ["4h", 4 * 3_600_000],
    ["1d", 24 * 3_600_000],
  ];

  for (const call of calls) {
    const eventTs = call.event_ts as number;
    const base = priceAt(prices, eventTs);
    if (base === null) continue;
    for (const [horizon, ms] of horizons) {
      const target = eventTs + ms;
      if (now < target) continue;
      const after = priceAt(prices, target, 15 * 60_000);
      if (after === null) continue;
      const move = (after - base) / base;
      const hit = call.bias === "Bullish" ? (move > 0.0002 ? 1 : 0) : move < -0.0002 ? 1 : 0;
      q.saveOutcome({ canon: call.canon ?? "unknown", eventTs, horizon, move, hit });
    }
  }
}

function priceAt(prices: PricePoint[], target: number, tolerance = 10 * 60_000): number | null {
  let best: PricePoint | null = null;
  let bestDelta = Infinity;
  for (const p of prices) {
    const d = Math.abs(p.ts - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  if (!best || bestDelta > tolerance) return null;
  return best.price;
}
