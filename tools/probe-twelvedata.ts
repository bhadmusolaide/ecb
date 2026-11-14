/**
 * One-off probe: what does this Twelve Data key actually give us for DXY?
 * Routed through curl (the egress path that actually works for this host).
 * Usage: node tools/probe-twelvedata.ts
 */
import { curlGet } from "../src/util/fetch.ts";

const KEY = process.env.TWELVE_DATA_KEY ?? "";
const BASE = "https://api.twelvedata.com";

async function get(path: string, tries = 6): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const txt = await curlGet(`${BASE}${path}${path.includes("?") ? "&" : "?"}apikey=${KEY}`, {
        timeoutMs: 15_000,
      });
      return JSON.parse(txt);
    } catch (err) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

const checks: [string, string][] = [
  ["/price?symbol=DXY", "DXY"],
  ["/price?symbol=USDX", "USDX"],
  ["/symbol_search?symbol=DXY&outputsize=30", "search DXY"],
  ["/indices", "indices list"],
  ["/forex_pairs", "forex pairs"],
  ["/quote?symbol=EUR/USD", "EUR/USD quote"],
];

for (const [path, label] of checks) {
  const j = await get(path);
  if (!j) {
    console.log(`${label.padEnd(16)} -> UNREACHABLE`);
    continue;
  }
  const s = JSON.stringify(j);
  console.log(`${label.padEnd(16)} -> ${s.slice(0, 700)}`);
}
