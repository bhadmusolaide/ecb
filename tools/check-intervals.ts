/**
 * Which interval gives us consistent bars across all six DXY legs?
 * Usage: node tools/check-intervals.ts
 */
import { curlGet } from "../src/util/fetch.ts";

const KEY = process.env.TWELVE_DATA_KEY!;
const BASE = "https://api.twelvedata.com";
const LEGS = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CAD", "USD/SEK", "USD/CHF"];

async function get(path: string, tries = 5): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return JSON.parse(await curlGet(`${BASE}${path}&apikey=${KEY}`, { timeoutMs: 10_000 }));
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null;
}

for (const interval of ["1h", "15min", "5min"]) {
  const sets: Set<number>[] = [];
  const report: string[] = [];
  for (const leg of LEGS) {
    const res = await get(
      `/time_series?symbol=${encodeURIComponent(leg)}&interval=${interval}&outputsize=300`,
    );
    const values = (res?.values ?? []) as { datetime: string }[];
    const set = new Set(values.map((v) => Date.parse(`${v.datetime.replace(" ", "T")}Z`)));
    sets.push(set);
    report.push(`${leg}=${set.size}`);
    await new Promise((r) => setTimeout(r, 7500));
  }
  let common = sets[0] ? [...sets[0]] : [];
  for (const s of sets.slice(1)) common = common.filter((t) => s.has(t));
  const union = new Set(sets.flatMap((s) => [...s]));
  console.log(
    `${interval.padEnd(6)} bars: ${report.join(" ")} | union=${union.size} intersection=${common.length}`,
  );
}
