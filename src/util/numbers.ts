/**
 * Numeric parsing for calendar values.
 * Handles: "0.3%", "-0.6M", "200K", "3.75M", "-404.1B", "1,234", "5.30|2.5" (auction -> null)
 */

export interface ParsedNumber {
  value: number;
  scale: "" | "K" | "M" | "B" | "%";
  unit: string; // "percent" | "thousands" | "millions" | "billions" | "raw"
}

const SCALE_UNIT: Record<string, string> = {
  K: "thousands",
  M: "millions",
  B: "billions",
  "%": "percent",
  "": "raw",
};

export function parseNumber(raw: string | number | null | undefined): ParsedNumber | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, scale: "", unit: "raw" } : null;
  const s = String(raw).trim();
  if (!s || s === "-" || s.toLowerCase() === "n/a" || s.toLowerCase() === "tbd" || s.toLowerCase() === "tbc")
    return null;
  // Auction results / ranges like "5.30|2.5" or "1.2-1.4" are not single values.
  if (s.includes("|") || /\d\s*-\s*\d/.test(s)) return null;
  const m = s.match(/^([+-]?\d[\d,]*\.?\d*)\s*([KMB%])?/);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const scale = (m[2] ?? "") as ParsedNumber["scale"];
  return { value, scale, unit: SCALE_UNIT[scale] };
}

export function fmtNumber(p: ParsedNumber | null, fallback = "–"): string {
  if (!p) return fallback;
  const sign = p.value < 0 ? "-" : "";
  const abs = Math.abs(p.value);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(abs % 1 === 0 ? 0 : 2);
  return `${sign}${body}${p.scale}`;
}

export function fmtValue(value: number | null, scale = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(abs % 1 === 0 ? 0 : 1);
  return `${sign}${body}${scale}`;
}
