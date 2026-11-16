/**
 * Investing.com calendar provider.
 *
 * The AJAX endpoint the site itself uses to populate the calendar table is a
 * POST that returns JSON with HTML row fragments. No Cloudflare blocks, no
 * aggressive rate-limiting. Used as a fallback when ForexFactory is blocked.
 *
 * Response format (varies by params):
 *   { success: true, data: [ "<tr>...</tr>", ... ] }  // array (with timeFilter)
 *   { data: "<tr>...</tr>..." }                        // string (without timeFilter)
 */
import { coolDown } from "../../util/fetch.ts";
import { etTimeToEpoch } from "../../util/time.ts";

interface InvestingResponse {
  success?: boolean;
  data?: string | string[];
}

export interface InvestingRow {
  currency: string;
  title: string;
  dateKey: string;
  time: string;
  impact: string;
  actualRaw: string;
  forecastRaw: string;
  previousRaw: string;
}

const API_URL = "https://www.investing.com/economic-calendar/Service/getCalendarFilteredData";

const STAR_RX = /grayFullBullishIcon|grayFullBearishIcon|greenFullBullishIcon|redFullBullishIcon|yellowFullBullishIcon/gi;

let lastOk = 0;
const MIN_INTERVAL = 300_000;

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cellStr(html: string, cls: string): string {
  const re = new RegExp(`<td[^>]*class=["'][^"']*${cls}[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const m = html.match(re);
  return m ? stripHtml(m[1]) : "";
}

function countStars(html: string): number {
  let n = 0;
  while (STAR_RX.exec(html)) n++;
  return n;
}

/** Normalize Investing.com titles to match the registry's ForexFactory-style patterns:
 *  - Convert parenthetical "MoM" → " m/m", "YoY" → " y/y", "QoQ" → " q/q"
 *  - Strip month/quarter suffixes like "(Nov)", "(Q3)"
 *  - Remove trailing whitespace */
function normalizeTitle(t: string): string {
  return t
    .replace(/\s+\(MoM\)/gi, " m/m")
    .replace(/\s+\(YoY\)/gi, " y/y")
    .replace(/\s+\(QoQ\)/gi, " q/q")
    .replace(/\s+\(WoW\)/gi, " w/w")
    .replace(/\s+\([A-Z][a-z]{2}(?:\s+\d{4})?\)/g, "") // (Nov), (Oct 2026)
    .replace(/\s+\(Q[1-4]\)/g, "")                       // (Q3)
    .replace(/\s+\([^)]*\)/g, "") // clear any remaining parenthetical parts
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseDateTimeAttr(html: string): { dateKey: string; time: string; ts: number } | null {
  const m = html.match(/data-event-datetime=["']([^"']+)["']/);
  if (!m) return null;
  // Format: "2026/11/18 05:30:00" (ET)
  const dtParts = m[1].split(" ");
  if (dtParts.length < 2) return null;
  const dateParts = dtParts[0].split("/");
  const timeParts = dtParts[1].split(":");
  if (dateParts.length < 3 || timeParts.length < 2) return null;
  const y = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const min = Number(timeParts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  const dateKeyStr = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  const ts = etTimeToEpoch(dateKeyStr, timeStr);

  return { dateKey: dateKeyStr, time: timeStr, ts };
}

function parseDateDay(html: string): string | null {
  // Date separator: <td class="theDay" id="theDay1795046400">
  const m = html.match(/class="theDay"[^>]*id="theDay(\d+)"/);
  if (m) {
    const ts = Number(m[1]) * 1000; // Unix seconds to ms
    if (Number.isFinite(ts)) {
      const d = new Date(ts);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    }
  }
  return null;
}

export async function fetchInvestingCalendar(): Promise<InvestingRow[]> {
  if (Date.now() - lastOk < MIN_INTERVAL) return [];

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 14);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const rows = await fetchRange(dateKey(from), dateKey(to));
  if (rows.length > 0) lastOk = Date.now();
  return rows;
}

async function fetchRange(dateFrom: string, dateTo: string): Promise<InvestingRow[]> {
  const body = `dateFrom=${dateFrom}&dateTo=${dateTo}&country[]=5&importance[]=1&importance[]=2&importance[]=3&timeZone=5`;

  let json: InvestingResponse;
  try {
    const txt = await curlPost(body);
    json = JSON.parse(txt);
  } catch {
    return [];
  }

  const raw = json.data;
  if (!raw) return [];

  const fragments: string[] = Array.isArray(raw) ? raw : [raw];
  return parseFragments(fragments);
}

function parseFragments(fragments: string[]): InvestingRow[] {
  const out: InvestingRow[] = [];
  const seen = new Set<string>();
  let currentDateKey = "";

  for (let part of fragments) {
    // Handle both array-of-rows and single-string-concatenation formats
    const rows = part.includes("<tr") ? part.split(/(?=<tr[^>]*>)/g).filter(Boolean) : [part];

    for (const row of rows) {
      // Date separators
      const dayKey = parseDateDay(row);
      if (dayKey) {
        currentDateKey = dayKey;
        continue;
      }

      // Skip non-event rows (date separators were already handled)
      if (!row.includes("js-event-item")) continue;

      // Parse date from data-event-datetime attribute
      const parsed = parseDateTimeAttr(row);
      if (!parsed) continue;
      const { dateKey: dk, time: tm } = parsed;
      if (!currentDateKey) currentDateKey = dk;

      const currency = cellStr(row, "flagCur").match(/\b[A-Z]{3}\b/)?.[0] ?? "";
      if (currency !== "USD") continue;

      const titleRaw = cellStr(row, "event");
      if (!titleRaw) continue;
      const title = normalizeTitle(titleRaw);

      const starCount = countStars(row);
      const impact = starCount >= 3 ? "High" : starCount === 2 ? "Medium" : "Low";

      const actualRaw = cellStr(row, "act");
      const forecastRaw = cellStr(row, "fore");
      const previousRaw = cellStr(row, "prev");

      // Deduplicate
      const key = `${currency}|${title}|${dk}|${tm}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip entries with no useful data
      if (!forecastRaw && !actualRaw && impact === "Low") continue;

      out.push({
        currency,
        title,
        dateKey: dk,
        time: tm,
        impact,
        actualRaw: actualRaw === "-" || actualRaw === "N/A" ? "" : actualRaw,
        forecastRaw: forecastRaw === "-" || forecastRaw === "N/A" ? "" : forecastRaw,
        previousRaw: previousRaw === "-" || previousRaw === "N/A" ? "" : previousRaw,
      });
    }
  }

  return out;
}

async function curlPost(body: string): Promise<string> {
  const args = [
    "-sSL", "--compressed", "--max-time", "20",
    "-w", "\n%{http_code}",
    "-X", "POST",
    "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "-H", "X-Requested-With: XMLHttpRequest",
    "-H", "Referer: https://www.investing.com/economic-calendar/",
    "-H", "Accept: application/json, text/javascript, */*; q=0.01",
    "--data-binary", body,
    API_URL,
  ];

  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

  const idx = out.lastIndexOf("\n");
  const status = Number(out.slice(idx + 1).trim());
  const bodyOut = out.slice(0, idx);
  if (status === 429 || status === 403) {
    coolDown(API_URL, 300_000);
    throw new Error(`HTTP ${status} for Investing.com`);
  }
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for Investing.com`);
  return bodyOut;
}