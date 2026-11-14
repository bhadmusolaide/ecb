import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, defFor } from "../src/engine/registry.ts";
import { computeSurprise, statsFrom } from "../src/engine/surprise.ts";
import { runEngine } from "../src/engine/composite.ts";
import { scoreText, stanceFromScore } from "../src/engine/lexicon.ts";
import { computeCalibration } from "../src/engine/calibration.ts";
import { buildPrePlan } from "../src/engine/preplan.ts";
import { parseNumber } from "../src/util/numbers.ts";
import { sessionFor, etTimeToEpoch, etParts } from "../src/util/time.ts";
import type { CalEvent } from "../src/types.ts";

const NOW = Date.parse("2026-11-12T14:00:00Z"); // 09:00 ET

function ev(partial: Partial<CalEvent> & { title: string; ts: number }): CalEvent {
  const def = classify(partial.title);
  return {
    id: `${partial.title}-${partial.ts}`,
    canon: def?.key ?? null,
    canonLabel: def?.label ?? null,
    currency: "USD",
    impact: "High",
    forecast: null,
    forecastRaw: "",
    previous: null,
    previousRaw: "",
    actual: null,
    actualRaw: "",
    surprise: null,
    surprisePct: null,
    z: null,
    surpriseSign: null,
    magnitude: null,
    contribution: null,
    bias: null,
    note: null,
    source: "test",
    released: false,
    ...partial,
  };
}

function released(
  title: string,
  actual: number,
  forecast: number | null,
  previous: number | null,
  ts = NOW - 3_600_000,
): CalEvent {
  const def = defFor(classify(title)?.key ?? "")!;
  const hist = statsFrom([]);
  const sur = computeSurprise(def, actual, forecast, previous, hist);
  const sign = sur.diff ?? sur.diffPrev ?? 0;
  return ev({
    title,
    ts,
    actual,
    forecast,
    previous,
    released: true,
    magnitude: sur.magnitude,
    surprise: sur.diff,
    surprisePct: sur.pct,
    surpriseSign: Math.sign(sign),
    z: sur.z,
    bias: "Neutral",
  });
}

// ---------------------------------------------------------------- registry
test("classifies the canonical US releases", () => {
  assert.equal(classify("Non-Farm Employment Change")?.key, "nfp");
  assert.equal(classify("Core CPI m/m")?.key, "core_cpi_mom");
  assert.equal(classify("CPI y/y")?.key, "cpi_yoy");
  assert.equal(classify("PPI m/m")?.key, "ppi_mom");
  assert.equal(classify("FOMC Statement")?.key, "fomc_statement");
  assert.equal(classify("FOMC Press Conference")?.key, "fomc_press_conference");
  assert.equal(classify("Unemployment Rate")?.key, "unemployment_rate");
  assert.equal(classify("Initial Jobless Claims")?.key, "weekly_claims");
  assert.equal(classify("ISM Manufacturing PMI")?.key, "ism_mfg");
  assert.equal(classify("Retail Sales m/m")?.key, "retail_sales_mom");
  assert.equal(classify("FOMC Member Waller Speaks")?.key, "fed_speech");
});

test("claims and unemployment are inverted for USD", () => {
  assert.equal(defFor("weekly_claims")?.sign, -1);
  assert.equal(defFor("unemployment_rate")?.sign, -1);
  assert.equal(defFor("core_cpi_yoy")?.sign, 1);
});

// ---------------------------------------------------------------- numbers
test("parses scaled calendar values", () => {
  assert.equal(parseNumber("0.3%")?.value, 0.3);
  assert.equal(parseNumber("-0.6M")?.value, -0.6);
  assert.equal(parseNumber("200K")?.value, 200);
  assert.equal(parseNumber("3.75M")?.value, 3.75);
  assert.equal(parseNumber("-404.1B")?.value, -404.1);
  assert.equal(parseNumber("5.30|2.5"), null);
  assert.equal(parseNumber(""), null);
});

// ---------------------------------------------------------------- surprise
test("a hot CPI prints a bigger magnitude than an in-line print", () => {
  const def = defFor("core_cpi_yoy")!;
  const hot = computeSurprise(def, 3.4, 3.2, 3.1, statsFrom([]));
  const inline = computeSurprise(def, 3.2, 3.2, 3.1, statsFrom([]));
  assert.ok(hot.magnitude! > inline.magnitude!);
  assert.equal(inline.inLine, true);
  assert.ok(inline.magnitude! <= 0.1);
});

test("z-score uses the event's own surprise history", () => {
  const def = defFor("nfp")!;
  const hist = statsFrom([10, -20, 30, -15, 25, -5, 40, -30, 12, 18]);
  const big = computeSurprise(def, 300, 100, 100, hist);
  const small = computeSurprise(def, 102, 100, 100, hist);
  assert.ok(big.z! > 1);
  assert.ok(Math.abs(small.z!) < 1);
  assert.ok(big.magnitude! > small.magnitude!);
  assert.ok(big.magnitude! <= 1);
});

// ---------------------------------------------------------------- composite
test("hot inflation produces a bullish DXY bias", () => {
  const out = runEngine({
    now: NOW,
    events: [released("Core CPI m/m", 0.4, 0.2, 0.3)],
    news: [],
    prices: [],
  });
  assert.equal(out.bias, "Bullish");
  assert.equal(out.stance, "Hawkish");
  assert.ok(out.score > 0);
});

test("cool inflation produces a bearish DXY bias", () => {
  const out = runEngine({
    now: NOW,
    events: [released("Core CPI m/m", 0.1, 0.3, 0.3)],
    news: [],
    prices: [],
  });
  assert.equal(out.bias, "Bearish");
  assert.equal(out.stance, "Dovish");
});

test("a strong payrolls print is USD bullish, a weak one is not", () => {
  const beat = runEngine({
    now: NOW,
    events: [released("Non-Farm Employment Change", 260, 130, 150)],
    news: [],
    prices: [],
  });
  const miss = runEngine({
    now: NOW,
    events: [released("Non-Farm Employment Change", 20, 130, 150)],
    news: [],
    prices: [],
  });
  assert.equal(beat.bias, "Bullish");
  assert.equal(miss.bias, "Bearish");
});

test("rising jobless claims are USD negative (inverted sign)", () => {
  const out = runEngine({
    now: NOW,
    events: [released("Initial Jobless Claims", 260, 210, 205)],
    news: [],
    prices: [],
  });
  assert.equal(out.bias, "Bearish");
});

test("rising unemployment is USD negative", () => {
  const out = runEngine({
    now: NOW,
    events: [released("Unemployment Rate", 4.4, 4.2, 4.2)],
    news: [],
    prices: [],
  });
  assert.equal(out.bias, "Bearish");
});

test("a hawkish FOMC statement drives a bullish bias", () => {
  const statement = ev({ title: "FOMC Statement", ts: NOW - 3_600_000, released: true });
  const out = runEngine({
    now: NOW,
    events: [statement],
    news: [],
    prices: [],
    lexScores: new Map([[statement.id, 2.5]]),
  });
  assert.equal(out.bias, "Bullish");
  assert.equal(out.stance, "Hawkish");
});

test("regime turns choppy when a tier-1 release is imminent", () => {
  const out = runEngine({
    now: NOW,
    events: [
      released("Core CPI m/m", 0.4, 0.2, 0.3),
      ev({ title: "FOMC Statement", ts: NOW + 10 * 60_000, impact: "High" }),
    ],
    news: [],
    prices: [],
  });
  assert.equal(out.regime, "Choppy");
  assert.ok(out.msToNext <= 30 * 60_000);
});

test("in-line prints leave the bias neutral", () => {
  const out = runEngine({
    now: NOW,
    events: [released("Core CPI m/m", 0.2, 0.2, 0.2)],
    news: [],
    prices: [],
  });
  assert.equal(out.bias, "Neutral");
  assert.ok(out.confidence < 0.6);
});

// ---------------------------------------------------------------- lexicon
test("lexicon separates hawkish from dovish language", () => {
  const hawk = scoreText("Inflation remains elevated and the Committee is prepared to raise rates further.");
  const dove = scoreText("The Committee remains patient and may begin to ease policy as disinflation continues.");
  assert.ok(hawk.score > 1);
  assert.ok(dove.score < -1);
  assert.equal(stanceFromScore(hawk.score), "Hawkish");
  assert.equal(stanceFromScore(dove.score), "Dovish");
});

// ---------------------------------------------------------------- preplan
test("pre-release plan states the flip thresholds", () => {
  const plan = buildPrePlan(
    ev({ title: "Core CPI m/m", ts: NOW + 3600_000, forecast: 0.2, previous: 0.3 }),
  );
  assert.ok(plan);
  assert.match(plan!.bullishIf, /above/);
  assert.match(plan!.bearishIf, /below/);
  assert.ok(plan!.watch.length > 0);
});

// ---------------------------------------------------------------- sessions
test("session windows follow New York time with DST handled", () => {
  // 2026-11-10 is EST (UTC-5), 2026-06-10 is EDT (UTC-4)
  const winterNight = etTimeToEpoch("2026-11-10", "22:00"); // 22:00 ET -> Asia session
  assert.equal(sessionFor(winterNight), "asia");
  const londonMorning = etTimeToEpoch("2026-11-10", "04:00");
  assert.equal(sessionFor(londonMorning), "london");
  const overlap = etTimeToEpoch("2026-11-10", "09:00");
  assert.equal(sessionFor(overlap), "london/ny");
  const nyAfternoon = etTimeToEpoch("2026-11-10", "14:00");
  assert.equal(sessionFor(nyAfternoon), "ny");
  const offHours = etTimeToEpoch("2026-11-10", "18:00");
  assert.equal(sessionFor(offHours), "off");

  // DST check: 09:00 ET in June is 13:00 UTC, in December 14:00 UTC
  assert.equal(etParts(etTimeToEpoch("2026-06-10", "09:00")).hour, 9);
  assert.equal(etParts(etTimeToEpoch("2026-12-10", "09:00")).hour, 9);
});

// ---------------------------------------------------------------- calibration
test("calibration shrinks the weight of event types that keep missing", () => {
  const rows = Array.from({ length: 10 }, () => ({ canon: "nfp", horizon: "1h", hit: 0 }));
  const cal = computeCalibration(rows);
  const nfp = cal.get("nfp")!;
  assert.ok(nfp.multiplier < 1);
  assert.ok(nfp.multiplier >= 0.65);

  const good = computeCalibration(
    Array.from({ length: 10 }, () => ({ canon: "core_cpi_yoy", horizon: "1h", hit: 1 })),
  ).get("core_cpi_yoy")!;
  assert.ok(good.multiplier > 1);
});

test("a single observation does not move the weight", () => {
  const cal = computeCalibration([{ canon: "nfp", horizon: "1h", hit: 0 }]);
  assert.equal(cal.get("nfp")!.multiplier, 1);
});
