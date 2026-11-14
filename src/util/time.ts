/**
 * Time utilities. All session logic is computed in the exchange timezone
 * (America/New_York) so DST is handled automatically.
 */
import { CONFIG } from "../config.ts";

export type SessionName = "asia" | "london" | "ny" | "london/ny" | "off";

export const SESSIONS: {
  name: SessionName;
  label: string;
  start: string;
  end: string;
  note: string;
}[] = [
  { name: "asia", label: "Asia", start: "19:00", end: "03:00", note: "Tokyo/Sydney handover" },
  { name: "london", label: "London", start: "03:00", end: "12:00", note: "European cash open" },
  { name: "ny", label: "New York", start: "08:00", end: "17:00", note: "US cash + data releases" },
  { name: "off", label: "Off-hours", start: "17:00", end: "19:00", note: "NY close into Asia" },
];

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CONFIG.timezone,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  minutesOfDay: number;
  dateKey: string; // YYYY-MM-DD in ET
}

export function etParts(d: Date | number): EtParts {
  const date = typeof d === "number" ? new Date(d) : d;
  const p = Object.fromEntries(
    partsFmt.formatToParts(date).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const day = Number(p.day);
  const month = Number(p.month);
  const year = Number(p.year);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: Number(p.second),
    weekday: p.weekday,
    minutesOfDay: hour * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** "08:30" -> 510 minutes */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number(x));
  return h * 60 + m;
}

export function sessionFor(d: Date | number): SessionName {
  const { minutesOfDay } = etParts(d);
  const m = minutesOfDay;
  const asiaStart = hmToMinutes("19:00");
  const londonStart = hmToMinutes("03:00");
  const nyStart = hmToMinutes("08:00");
  const nyEnd = hmToMinutes("17:00");
  const londonEnd = hmToMinutes("12:00");

  const inAsia = m >= asiaStart || m < londonStart;
  const inLondon = m >= londonStart && m < londonEnd;
  const inNy = m >= nyStart && m < nyEnd;

  if (inLondon && inNy) return "london/ny";
  if (inNy) return "ny";
  if (inLondon) return "london";
  if (inAsia) return "asia";
  return "off";
}

export function sessionMeta(name: SessionName) {
  return SESSIONS.find((s) => s.name === name) ?? SESSIONS[3];
}

/** Is the market actively trading right now? */
export function isActiveSession(d: Date | number): boolean {
  const s = sessionFor(d);
  return s === "asia" || s === "london" || s === "ny" || s === "london/ny";
}

export function fmtEtTime(ts: number): string {
  const p = etParts(ts);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function fmtEtDate(ts: number): string {
  const p = etParts(ts);
  return `${p.weekday} ${p.month}/${p.day}`;
}

export function fmtEtFull(ts: number): string {
  const p = etParts(ts);
  return `${p.weekday} ${p.month}/${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET`;
}

/** Offset of the exchange timezone vs UTC in minutes at a given instant (e.g. -240 for EDT). */
export function tzOffsetMinutes(ts: number): number {
  const p = etParts(ts);
  const utc = new Date(ts).getUTCHours() * 60 + new Date(ts).getUTCMinutes();
  let diff = p.minutesOfDay - utc;
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}

/** Build an epoch ms for a given ET wall-clock time on the ET date of `refTs`. */
export function etTimeToEpoch(dateKey: string, hm: string): number {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  // Guess UTC then correct with the offset at that instant (two-pass).
  let ts = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(ts);
    const corrected = Date.UTC(y, mo - 1, d, h, mi) - off * 60_000;
    if (corrected === ts) break;
    ts = corrected;
  }
  return ts;
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / 60_000);
}

export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60_000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(abs / 1000)}s`;
}
