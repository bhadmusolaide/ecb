/**
 * Global configuration. Everything is env-driven so the app can run keyless.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

function envStr(k: string, d = ""): string {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
}
function envNum(k: string, d: number): number {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v !== 0 ? v : d;
}

export const CONFIG = {
  port: envNum("PORT", 4173),
  host: envStr("HOST", "127.0.0.1"),
  dataDir: envStr("DATA_DIR", path.join(ROOT, "data")),
  dbFile: envStr("DB_FILE", path.join(ROOT, "data", "ecb.sqlite")),

  /** Canonical display timezone for the whole app. */
  timezone: envStr("APP_TZ", "America/New_York"),

  /** Price provider: auto | twelvedata | finage | proxy */
  priceProvider: envStr("PRICE_PROVIDER", "auto"),
  twelveDataKey: envStr("TWELVE_DATA_KEY"),
  finageKey: envStr("FINAGE_KEY"),
  priceSymbol: envStr("PRICE_SYMBOL", "DXY"),

  /** Optional LLM analyst layer (never touches the surprise math). */
  llm: {
    apiKey: envStr("LLM_API_KEY"),
    baseUrl: envStr("LLM_BASE_URL", "https://api.openai.com/v1"),
    model: envStr("LLM_MODEL", "gpt-4o-mini"),
    timeoutMs: envNum("LLM_TIMEOUT_MS", 20000),
  },

  /** Poll policy (ms). */
  poll: {
    idleCalendar: envNum("POLL_IDLE_CALENDAR_MS", 5 * 60_000),
    activeCalendar: envNum("POLL_ACTIVE_CALENDAR_MS", 60_000),
    nearEventCalendar: envNum("POLL_NEAR_EVENT_CALENDAR_MS", 5_000),
    news: envNum("POLL_NEWS_MS", 5 * 60_000),
    newsFast: envNum("POLL_NEWS_FAST_MS", 60_000),
    price: envNum("POLL_PRICE_MS", 60_000),
    priceFast: envNum("POLL_PRICE_FAST_MS", 15_000),
  },

  /** How far back (hours) released events keep influencing the session score. */
  eventInfluenceHours: envNum("EVENT_INFLUENCE_HOURS", 18),
} as const;

export const HTTP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
