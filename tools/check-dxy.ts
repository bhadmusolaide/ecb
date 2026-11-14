/**
 * Diagnostic: reconcile the Twelve Data spot prices with the time-series closes
 * and with the DXY we compute from them.
 * Usage: node tools/check-dxy.ts
 */
import { curlGet } from "../src/util/fetch.ts";
import { dxyFromRates, ICE_LEGS } from "../src/providers/price/index.ts";

const KEY = process.env.TWELVE_DATA_KEY!;
const BASE = "https://api.twelvedata.com";

async function get(path: string, tries = 8): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return JSON.parse(await curlGet(`${BASE}${path}&apikey=${KEY}`, { timeoutMs: 12_000 }));
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const symbols = ICE_LEGS.map((l) => l.symbol).join(",");

console.log("--- spot /price ---");
const spot = await get(`/price?symbol=${encodeURIComponent(symbols)}`);
for (const leg of ICE_LEGS) {
  console.log(leg.symbol.padEnd(9), JSON.stringify(spot?.[leg.symbol]));
}

console.log("--- last time_series close per leg ---");
const rates = new Map<string, number>();
for (const leg of ICE_LEGS) {
  const ts = await get(`/time_series?symbol=${encodeURIComponent(leg.symbol)}&interval=5min&outputsize=2`);
  const v = ts?.values?.[0];
  const close = Number(v?.close);
  if (Number.isFinite(close)) rates.set(leg.symbol, close);
  console.log(leg.symbol.padEnd(9), v?.datetime, close);
}
console.log("DXY from series closes:", dxyFromRates(rates)?.toFixed(4));

const spotRates = new Map<string, number>();
for (const leg of ICE_LEGS) {
  const p = Number(spot?.[leg.symbol]?.price);
  if (Number.isFinite(p)) spotRates.set(leg.symbol, p);
}
console.log("DXY from spot prices :", dxyFromRates(spotRates)?.toFixed(4));

console.log("--- /quote (same feed, different endpoint) ---");
const quote = await get(`/quote?symbol=${encodeURIComponent(symbols)}`);
for (const leg of ICE_LEGS) {
  console.log(leg.symbol.padEnd(9), quote?.[leg.symbol]?.close, quote?.[leg.symbol]?.datetime);
}
