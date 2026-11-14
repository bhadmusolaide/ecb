/**
 * Multi-symbol price providers.
 *
 *  - twelvedata : real FX legs (DXY via ICE weights), direct EUR/USD, XAU/USD, BTC/USD,
 *                 and QNDX (SPDR Nasdaq 100 ETF) as the NAS100 proxy.
 *  - finage     : direct index quote (used when a Finage key is configured).
 *  - proxy      : keyless fallback, ICE-weighted DXY from Coinbase spot FX; EUR/USD
 *                 also proxied from Coinbase.
 *
 * All providers return real market prices. The source string always says which one is live.
 */
import { CONFIG } from "../../config.ts";
import { fetchJson, curlGet, RateLimitError } from "../../util/fetch.ts";

export interface Quote {
  price: number;
  source: string;
  ts: number;
  proxy: boolean;
  /** true when the number is an index we rebuild from FX legs rather than a quoted index */
  computed: boolean;
}

export interface Candle {
  ts: number;
  price: number;
}

/** ICE DXY basket: [symbol, weight, exponent sign]. The formula is
 *  DXY = 50.14348112 * EURUSD^-0.576 * USDJPY^0.136 * GBPUSD^-0.119 * USDCAD^0.091 * USDSEK^0.042 * USDCHF^0.036 */
export const ICE_LEGS: { symbol: string; weight: number; positive: boolean }[] = [
  { symbol: "EUR/USD", weight: 0.576, positive: false },
  { symbol: "USD/JPY", weight: 0.136, positive: true },
  { symbol: "GBP/USD", weight: 0.119, positive: false },
  { symbol: "USD/CAD", weight: 0.091, positive: true },
  { symbol: "USD/SEK", weight: 0.042, positive: true },
  { symbol: "USD/CHF", weight: 0.036, positive: true },
];

const DXY_CONST = 50.14348112;

/** Supported instruments and their Twelve Data symbol names.
 *  DXY is computed from ICE legs; NAS100 uses QNDX ETF as a proxy since Twelve Data
 *  does not list the NAS100 index on the free tier.
 */
export const SUPPORTED_SYMBOLS: { key: string; label: string; tdSymbol: string; computed: boolean }[] = [
  { key: "DXY", label: "US Dollar Index", tdSymbol: "DXY", computed: true },
  { key: "EURUSD", label: "EUR / USD", tdSymbol: "EUR/USD", computed: false },
  { key: "XAUUSD", label: "Gold / USD", tdSymbol: "XAU/USD", computed: false },
  { key: "BTCUSD", label: "BTC / USD", tdSymbol: "BTC/USD", computed: false },
  { key: "NAS100", label: "Nasdaq 100 (QNDX ETF)", tdSymbol: "QNDX", computed: false },
];

export const SYMBOL_KEYS = SUPPORTED_SYMBOLS.map((s) => s.key);

export function tdSymbolFor(key: string): string | null {
  const s = SUPPORTED_SYMBOLS.find((x) => x.key === key);
  return s ? s.tdSymbol : null;
}

export function labelFor(key: string): string | null {
  const s = SUPPORTED_SYMBOLS.find((x) => x.key === key);
  return s ? s.label : null;
}

export function dxyFromRates(rates: Map<string, number>): number | null {
  let value = DXY_CONST;
  let weightSum = 0;
  for (const leg of ICE_LEGS) {
    const r = rates.get(leg.symbol);
    if (!r || !Number.isFinite(r) || r <= 0) continue;
    weightSum += leg.weight;
  }
  if (weightSum < 0.9) return null; // too few legs to be meaningful
  for (const leg of ICE_LEGS) {
    const r = rates.get(leg.symbol);
    if (!r || !Number.isFinite(r) || r <= 0) continue;
    const exponent = (leg.weight / weightSum) * (leg.positive ? 1 : -1);
    value *= Math.pow(r, exponent);
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ twelve data */

/**
 * Twelve Data free tier allows 8 requests/minute, and the network path to it is flaky,
 * so requests are spaced out and retried.
 */
class TwelveDataClient {
  private lastCall = 0;
  private queue: Promise<unknown> = Promise.resolve();

  async get(path: string): Promise<any | null> {
    const run = async (): Promise<any | null> => {
      const key = CONFIG.twelveDataKey;
      if (!key) return null;
      const url = `https://api.twelvedata.com${path}${path.includes("?") ? "&" : "?"}apikey=${key}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = 7500 - (Date.now() - this.lastCall);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastCall = Date.now();
        try {
          const txt = await curlGet(url, { timeoutMs: 12_000 });
          return JSON.parse(txt);
        } catch (err) {
          if (err instanceof RateLimitError && attempt === 0) {
            await new Promise((r) => setTimeout(r, 4000));
            continue;
          }
          await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
        }
      }
      return null;
    };

    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => null);
    return chained;
  }
}

const td = new TwelveDataClient();

async function twelveDataDirect(symbol: string): Promise<Quote | null> {
  const res = await td.get(`/price?symbol=${encodeURIComponent(symbol)}`);
  if (!res || typeof res !== "object") return null;
  const p = Number(res?.price ?? res?.close ?? res?.value);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    price: p,
    source: `twelvedata:${symbol}`,
    ts: Date.now(),
    proxy: false,
    computed: false,
  };
}

async function twelveDataDxy(): Promise<Quote | null> {
  // 1) if the index itself is ever available, use it directly
  const direct = await td.get("/price?symbol=DXY");
  const directPrice = Number(direct?.value ?? direct?.DXY?.price);
  if (Number.isFinite(directPrice) && directPrice > 20 && directPrice < 200) {
    return { price: directPrice, source: "twelvedata:DXY", ts: Date.now(), proxy: false, computed: false };
  }

  // 2) otherwise rebuild the index from the real FX legs (one request, six symbols)
  const symbols = ICE_LEGS.map((l) => l.symbol).join(",");
  const res = await td.get(`/price?symbol=${encodeURIComponent(symbols)}`);
  if (!res || typeof res !== "object") return null;

  const rates = new Map<string, number>();
  for (const leg of ICE_LEGS) {
    const entry = res[leg.symbol];
    const p = Number(entry?.price ?? entry?.close);
    if (Number.isFinite(p) && p > 0) rates.set(leg.symbol, p);
  }
  if (rates.size < 5) return null;

  const value = dxyFromRates(rates);
  if (value === null) return null;
  return {
    price: value,
    source: `twelvedata:ice-dxy(${rates.size}/6 legs)`,
    ts: Date.now(),
    proxy: false,
    computed: true,
  };
}

/* ------------------------------------------------------------------ finage */

async function finageQuote(symbol: string): Promise<Quote | null> {
  const url = `https://api.finage.co.uk/last/candle/${encodeURIComponent(symbol)}?apikey=${CONFIG.finageKey}`;
  const j = await fetchJson<{ c?: number; t?: number }[]>(url);
  const row = Array.isArray(j) ? j[j.length - 1] : j;
  if (!row || typeof row.c !== "number") return null;
  return {
    price: row.c,
    source: `finage:${symbol}`,
    ts: row.t ? row.t * 1000 : Date.now(),
    proxy: false,
    computed: false,
  };
}

/* ------------------------------------------------------------------ coinbase proxy */

/** Coinbase spot pairs for the keyless proxy. EUR/USD and DXY-legs are supported. */
const COINBASE_PAIRS: { pair: string; symbol: string; invert: boolean }[] = [
  { pair: "EUR-USD", symbol: "EUR/USD", invert: false },
  { pair: "JPY-USD", symbol: "USD/JPY", invert: true },
  { pair: "GBP-USD", symbol: "GBP/USD", invert: false },
  { pair: "CAD-USD", symbol: "USD/CAD", invert: true },
  { pair: "SEK-USD", symbol: "USD/SEK", invert: true },
  { pair: "CHF-USD", symbol: "USD/CHF", invert: true },
];

async function proxyQuoteFor(symbol: string): Promise<Quote | null> {
  if (symbol === "EUR/USD") {
    const j = await fetchJson<{ data?: { amount?: string } }>(
      `https://api.coinbase.com/v2/prices/EUR-USD/spot`,
      { timeoutMs: 8000, retries: 1 },
    );
    const amt = Number(j?.data?.amount);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    return { price: amt, source: "proxy:coinbase-fx", ts: Date.now(), proxy: true, computed: false };
  }
  if (symbol === "DXY") {
    const rates = new Map<string, number>();
    const results = await Promise.allSettled(
      COINBASE_PAIRS.map(async ({ pair }) => {
        const j = await fetchJson<{ data?: { amount?: string } }>(
          `https://api.coinbase.com/v2/prices/${pair}/spot`,
          { timeoutMs: 8000, retries: 1 },
        );
        const amt = Number(j?.data?.amount);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error(`bad rate for ${pair}`);
        return [pair, amt] as const;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const entry = COINBASE_PAIRS.find((p) => p.pair === r.value[0]);
        if (entry) rates.set(entry.symbol, entry.invert ? 1 / r.value[1] : r.value[1]);
      }
    }
    if (rates.size < 4) throw new Error("not enough FX pairs for proxy");
    const value = dxyFromRates(rates);
    if (value === null) throw new Error("proxy DXY failed");
    return { price: value, source: "proxy:coinbase-fx", ts: Date.now(), proxy: true, computed: true };
  }
  return null;
}

/* ------------------------------------------------------------------ public API */

export async function getQuote(key: string): Promise<Quote | null> {
  const tdSymbol = tdSymbolFor(key);
  if (!tdSymbol) return null;

  const provider = CONFIG.priceProvider;

  if (provider === "twelvedata" || (provider === "auto" && CONFIG.twelveDataKey)) {
    try {
      if (key === "DXY") {
        const q = await twelveDataDxy();
        if (q) return q;
      } else {
        const q = await twelveDataDirect(tdSymbol);
        if (q) return q;
      }
    } catch (err) {
      console.warn(`[price] twelvedata failed for ${key}:`, (err as Error).message);
    }
  }
  if (provider === "finage" || (provider === "auto" && CONFIG.finageKey)) {
    try {
      const q = await finageQuote(tdSymbol);
      if (q) return q;
    } catch (err) {
      console.warn(`[price] finage failed for ${key}:`, (err as Error).message);
    }
  }
  try {
    const q = await proxyQuoteFor(tdSymbol);
    if (q) return q;
  } catch (err) {
    console.warn(`[price] proxy failed for ${key}:`, (err as Error).message);
  }
  return null;
}

export async function getAllQuotes(): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (const key of SYMBOL_KEYS) {
    try {
      const q = await getQuote(key);
      if (q) out.set(key, q);
    } catch (err) {
      console.warn(`[price] getQuote(${key}) failed:`, (err as Error).message);
    }
  }
  return out;
}

/**
 * Real candles for a single symbol, from Twelve Data time series.
 * DXY is rebuilt from the FX legs' own time series; other symbols are fetched directly.
 */
export async function getCandles(key: string, interval = "5min", outputsize = 300): Promise<Candle[]> {
  if (key === "DXY") {
    if (CONFIG.twelveDataKey) {
      try {
        const series = await Promise.all(
          ICE_LEGS.map(async (leg) => {
            const res = await td.get(
              `/time_series?symbol=${encodeURIComponent(leg.symbol)}&interval=${interval}&outputsize=${outputsize}`,
            );
            const values = res?.values as { datetime: string; close: string }[] | undefined;
            const map = new Map<number, number>();
            for (const v of values ?? []) {
              const ts = Date.parse(`${v.datetime.replace(" ", "T")}Z`);
              const close = Number(v.close);
              if (Number.isFinite(ts) && Number.isFinite(close) && close > 0) map.set(ts, close);
            }
            return [leg.symbol, map] as const;
          }),
        );

        const common = new Set<number>();
        for (const [, map] of series) {
          for (const ts of map.keys()) common.add(ts);
        }
        const stamps = [...common]
          .filter((ts) => series.every(([, map]) => map.has(ts)))
          .sort((a, b) => a - b);

        const out: Candle[] = [];
        for (const ts of stamps) {
          const rates = new Map<string, number>();
          for (const [symbol, map] of series) {
            const v = map.get(ts);
            if (v !== undefined) rates.set(symbol, v);
          }
          const value = dxyFromRates(rates);
          if (value !== null) out.push({ ts, price: value });
        }
        if (out.length > 0) return out;
      } catch (err) {
        console.warn(`[price] candle build for DXY failed:`, (err as Error).message);
      }
    }
    return [];
  }

  const tdSymbol = tdSymbolFor(key);
  if (!tdSymbol || !CONFIG.twelveDataKey) return [];

  try {
    const res = await td.get(
      `/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${outputsize}`,
    );
    const values = res?.values as { datetime: string; close: string }[] | undefined;
    const out: Candle[] = [];
    for (const v of values ?? []) {
      const ts = Date.parse(`${v.datetime.replace(" ", "T")}Z`);
      const close = Number(v.close);
      if (Number.isFinite(ts) && Number.isFinite(close) && close > 0) out.push({ ts, price: close });
    }
    return out;
  } catch (err) {
    console.warn(`[price] candles for ${key} failed:`, (err as Error).message);
    return [];
  }
}

export async function getAllCandles(interval = "5min", outputsize = 300): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  for (const key of SYMBOL_KEYS) {
    try {
      const candles = await getCandles(key, interval, outputsize);
      if (candles.length > 0) out.set(key, candles);
    } catch (err) {
      console.warn(`[price] getCandles(${key}) failed:`, (err as Error).message);
    }
  }
  return out;
}
