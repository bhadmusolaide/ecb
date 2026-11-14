/**
 * ForexFactory calendar provider.
 *
 * The public JSON feed (nfs.faireconomy.media) carries schedule + impact + forecast + previous
 * for the current week only, and never carries the *actual*.
 * The website HTML carries everything (including actuals) for this week and next week, but
 * sits behind a CDN that rate-limits aggressively - so we parse it with browser-like headers,
 * pace the requests, and treat a 403 as "keep the data we already have".
 *
 * Times on the site are rendered in the site timezone; we force it with the "fftimezone" cookie.
 */
import { fetchText, curlGet, RateLimitError } from "../../util/fetch.ts";
import { etTimeToEpoch } from "../../util/time.ts";
import { parseNumber } from "../../util/numbers.ts";

export interface RawFeedEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
}

export interface ScrapedRow {
  currency: string;
  title: string;
  dateKey: string; // YYYY-MM-DD
  time: string; // HH:MM (24h, ET)
  impact: string;
  actualRaw: string;
  forecastRaw: string;
  previousRaw: string;
}

const JSON_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"];

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.forexfactory.com/calendar",
};

export async function fetchFeedEvents(): Promise<RawFeedEvent[]> {
  const out: RawFeedEvent[] = [];
  for (const url of JSON_URLS) {
    try {
      let txt: string;
      try {
        txt = await fetchText(url, { timeoutMs: 15000, retries: 1 });
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err;
        txt = await curlGet(url, { timeoutMs: 15000, headers: BROWSER_HEADERS });
      }
      const arr = JSON.parse(txt) as RawFeedEvent[];
      out.push(...arr);
    } catch (err) {
      console.warn(`[calendar] feed failed ${url}:`, (err as Error).message);
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => {
    const ts = Date.parse(e.date);
    const key = `${e.country}|${e.title}|${Number.isFinite(ts) ? ts : e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const IMPACT_MAP: Record<string, string> = {
  "icon--ff-impact-red": "High",
  "icon--ff-impact-yel": "Medium",
  "icon--ff-impact-grn": "Low",
  "icon--ff-impact-choc": "Holiday",
};

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cell(row: string, cls: string): string {
  const re = new RegExp(`calendar__cell ${cls}[^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const m = row.match(re);
  return m ? strip(m[1]) : "";
}

/** Scrape one week of the FF calendar (schedule + forecast + previous + actual). */
const lastFetch: Record<string, number> = {};
const MIN_INTERVAL: Record<string, number> = { this: 120_000, next: 900_000 };

export async function fetchWeek(week: "this" | "next"): Promise<ScrapedRow[]> {
  const last = lastFetch[week] ?? 0;
  if (Date.now() - last < (MIN_INTERVAL[week] ?? 120_000)) {
    throw new Error(`week=${week} recently fetched, skipping to stay under the rate limit`);
  }
  const url = `https://www.forexfactory.com/calendar?week=${week}`;
  const headers = { ...BROWSER_HEADERS, Cookie: "fftimezone=America/New_York" };
  let html: string;
  try {
    html = await fetchText(url, { timeoutMs: 25000, retries: 1, cooldownMs: 180_000, headers });
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    // Cloudflare blocks Node's TLS fingerprint - retry through curl.
    html = await curlGet(url, { timeoutMs: 25000, headers });
  }
  lastFetch[week] = Date.now();
  return parseCalendarHtml(html);
}

export function parseCalendarHtml(html: string): ScrapedRow[] {
  const rows = html.split(/<tr data-event-id=/).slice(1);
  const out: ScrapedRow[] = [];
  let currentDateKey = "";
  let lastTime = "";

  for (const row of rows) {
    const dateline = row.match(/data-day-dateline="(\d+)"/);
    if (dateline) {
      // The dateline is a UTC-ish timestamp whose UTC calendar day is the event's date.
      const d = new Date(Number(dateline[1]) * 1000);
      currentDateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
        d.getUTCDate(),
      ).padStart(2, "0")}`;
      lastTime = "";
    }
    const currency = cell(row, "calendar__currency");
    const title = cell(row, "calendar__event");
    const timeRaw = cell(row, "calendar__time");
    if (!currency || !title || !currentDateKey) continue;

    const impactCell = row.match(/calendar__cell calendar__impact[^>]*>([\s\S]*?)<\/td>/i);
    let impact = "Low";
    if (impactCell) {
      const m = impactCell[1].match(/icon--ff-impact-\w+/);
      if (m) impact = IMPACT_MAP[m[0]] ?? "Low";
    }

    // The site prints the time only on the first row of a time group - carry it forward.
    const time = timeRaw ? normalizeTime(timeRaw) : lastTime;
    if (!/^\d{2}:\d{2}$/.test(time)) continue; // skips "Oct 17th" monthly markers
    lastTime = time;

    out.push({
      currency,
      title,
      dateKey: currentDateKey,
      time,
      impact,
      actualRaw: cell(row, "calendar__actual"),
      forecastRaw: cell(row, "calendar__forecast"),
      previousRaw: cell(row, "calendar__previous"),
    });
  }
  return out;
}

/** Normalise "2:30pm" -> "14:30" */
export function normalizeTime(t: string): string {
  const m = t.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (!m) return "";
  let h = Number(m[1]);
  const mm = m[2];
  const ap = m[3];
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

/** Timestamp (epoch ms) for a scraped row, honouring ET DST. */
export function rowTimestamp(row: ScrapedRow): number {
  return etTimeToEpoch(row.dateKey, row.time);
}

export function parseActual(raw: string): number | null {
  return parseNumber(raw)?.value ?? null;
}
