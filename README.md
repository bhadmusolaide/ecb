# Economic Calendar Bias

Translates US macro releases (FOMC, NFP, CPI, PPI, ISM, claims, Fed speakers) and
global/geopolitical news into an **actionable DXY bias** — with the reasoning chain,
the pre-release decision tree, and a self-scored track record.

It replaces the manual loop of "open ForexFactory, stare at forecast vs previous,
wait for the actual, then decide" with an explicit, auditable translation layer.

```
release → canonical event → unit normalisation → surprise vs consensus
        → z-score vs that event's own history → USD sign table × materiality
        → decayed session score → BIAS + CONFIDENCE + REGIME
```

## Quick start (no API keys needed)

```bash
cd economic-calendar-bias
npm start                 # http://127.0.0.1:4173
```

Node 22.6+ is required (it runs the TypeScript directly — no build step, no npm install).
`npm test` runs the engine test suite with the built-in test runner.

```bash
node src/cli.ts now       # current bias in the terminal
node src/cli.ts events 7  # next 7 days of USD events
node src/cli.ts replay 14 # what we said at each past release vs the DXY move
node src/cli.ts stats     # hit-rate table
node src/cli.ts refresh   # force a full refresh
```

## The three axes it reports

| Axis | Values | Question it answers |
|---|---|---|
| **Bias** | Bullish · Bearish · Neutral | Where does DXY lean from here? |
| **Stance** | Hawkish · Dovish · Neutral | What does the release say about the *policy path*? |
| **Regime** | Choppy · Trending | Should I expect clean follow-through or whipsaw? |

A release can be hawkish *and* neutral (already priced), or hawkish *and* choppy
(hot CPI into weak payrolls = two-way risk). The app never collapses these into one word.

## How the translation works

1. **Canonical registry** (`src/engine/registry.ts`) — ~45 event definitions, each with:
   * a materiality weight (FOMC 1.00 → retail sales 0.50 → energy inventories 0.15),
   * a USD sign convention (higher = hawkish, *except* jobless claims and the unemployment
     rate which are inverted),
   * an "in-line" tolerance band (a 0.05pp CPI miss is noise, a 0.10pp miss is not).
2. **Surprise maths** (`src/engine/surprise.ts`) — `actual − consensus`, expressed both in
   native units and as a z-score against the rolling history of *that same event*
   (so a 60K payrolls miss and a 0.1pp CPI miss are comparable). With no history yet it
   falls back to the tolerance band, and switches to the z-score once six prints exist.
3. **Composite** (`src/engine/composite.ts`) — every released event inside the influence
   window contributes `sign × weight × magnitude × surprise_direction × decay`. The decay
   (`exp(−age/8h)`) means a 08:30 ET print still matters in the NY afternoon but not the
   next morning. The sum becomes the bias, the stance and the confidence.
4. **Regime** — choppy is triggered by an imminent tier-1 release, conflicting inflation vs
   growth impulses, a news tilt that opposes the calendar impulse, or elevated DXY
   realised volatility.
5. **Pre-release plan** (`src/engine/preplan.ts`) — for every upcoming event: the exact
   number that flips the bias bullish, the number that flips it bearish, what "in line"
   means, and what to watch alongside it (u-rate + AHE for NFP, core vs headline for CPI,
   SEP dots for FOMC).

## News and geopolitics

`src/providers/news/rss.ts` aggregates the Fed press feed, WSJ markets, Guardian world and
eight targeted Google News queries, then classifies each headline for DXY relevance,
direction (USD+/USD−) and severity (tier 1 = market-moving). Tier-1 events (war
escalation, sanctions, sovereign stress, emergency Fed action, oil shock) are surfaced in
the session context and can cap the bias at *Choppy* when they oppose the calendar impulse.

Optional LLM layer (`src/llm/analyst.ts`, off unless `LLM_API_KEY` is set) adds:
a hawkish/dovish read of the FOMC statement text, and a second opinion on headlines the
rules cannot classify. It never touches the surprise maths.

## Sessions and refresh cadence (New York time, DST handled)

| Session | ET window | Poll cadence |
|---|---|---|
| Asia | 19:00 → 03:00 | calendar 5 min, price 5 min, news 15 min |
| London | 03:00 → 12:00 | calendar 60 s, price 60 s, news 5 min |
| New York | 08:00 → 17:00 | calendar 60 s, price 60 s, news 5 min |
| Off-hours | 17:00 → 19:00 | relaxed |

Inside 30 minutes of a high-impact release the loop tightens to 5 s for the calendar and
15 s for price, so the actual is captured within seconds of landing. All session
boundaries are computed in `America/New_York`, so they shift with DST automatically.

## Self-scoring

Every material release is logged as a *call* (bias, confidence, score). Once the DXY has
moved, the outcome is scored at +30 min / 1 h / 4 h / 1 d and the hit rate is reported per
event type in the Journal tab. `node src/cli.ts replay 14` shows the same thing for the
past two weeks. This is the feedback loop that keeps the weights honest.

## Data sources

| Data | Source |
|---|---|
| Calendar (schedule, impact, forecast, previous, **actual**) | ForexFactory — public JSON feed + website scrape (ET timezone forced via cookie) |
| Fed statements / minutes / speeches | federalreserve.gov press + speeches feeds (full text → hawkish/dovish lexicon) |
| News & geopolitics | Fed press, WSJ Markets, Guardian World, 8 targeted Google News RSS queries |
| DXY price | **Twelve Data real FX legs** (EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK, USD/CHF) combined with the official ICE weights into the index — Twelve Data does not quote the index itself, so the app rebuilds it from its legs. Fallbacks: Finage (direct index quote) → Coinbase spot FX |
| EUR/USD, XAU/USD, BTC/USD | **Twelve Data direct quotes** (live forex / gold / crypto pairs) |
| NAS100 | **QNDX ETF** (SPDR Nasdaq 100 ETF) via Twelve Data — free tier has no NAS100 index, hidden when market closed |
| US rates / curve | optional — not wired yet (see PLAN.md) |

### Supported instruments on the price ticker

DXY · EURUSD · XAUUSD · BTCUSD · NAS100 — selectable from the header dropdown. Only symbols with live data are offered; closed markets show "market closed" rather than a stale or zero price.

### Everything on screen is real market data

* The calendar, forecasts, previous values and actuals are the live ForexFactory values
  (scraped from the site, not the demo feed).
* The DXY level is computed from **live FX quotes**, not synthetic data. The source string in
  the header always names the feed, e.g. `twelvedata:ice-dxy(6/6 legs)`. If every feed fails
  the card shows `no feed` rather than a placeholder number.
* News items are real headlines with their real links and timestamps.
* Nothing in the UI is seeded, faked or back-filled. The only derived numbers are the
  *engine's* own outputs (surprise, z-score, impact score) — those are labelled as such.


Note: ForexFactory sits behind a CDN that rate-limits aggressively, so the scraper paces
itself, backs off on 403/429 and falls back to the public JSON feed. Node's TLS fingerprint
is blocked by their CDN, so HTML requests are routed through `curl`.

## Configuration

Copy `.env.example` → `.env` and edit. The app reads env vars directly:

```bash
node --env-file-if-exists=.env src/server.ts
```

Everything is optional. With no keys it runs on the synthetic DXY proxy and rules-only
analysis.

## Layout

```
src/
  engine/      registry · surprise maths · composite · lexicon · preplan
  providers/   calendar (forexfactory, fed) · news (rss) · price (twelvedata/finage/proxy)
  service/     pipeline (fetch → merge → analyse → persist) · scheduler (session-aware)
  store/       sqlite schema + queries (node:sqlite, no native deps)
  llm/         optional analyst layer
  web/         dashboard (vanilla JS, no build)
  cli.ts · server.ts · config.ts
tests/         engine test suite (node:test)
```

## Known limits

* The z-score layer needs six prints of an event before it activates — the tolerance band
  governs until then.
* The DXY feed is the index rebuilt from its six FX legs (Twelve Data does not quote the
  index itself). It tracks the published index closely but is not tick-identical to it.
* Bias is currently DXY-only, by design — the engine's sign table and weights are calibrated
  to US macro → DXY. EURUSD/XAU/BTC/NAS100 prices are shown as real market data but do not
  have their own bias cards yet (per-instrument factor maps are on the roadmap).
