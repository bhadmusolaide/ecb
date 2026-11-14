/**
 * SQLite persistence (node:sqlite, no native deps).
 *
 * events           - merged calendar rows (schedule + forecast + previous + actual) + engine output
 * surprise_history - rolling history of surprises per canonical event (drives z-scores)
 * calls            - every bias call the engine made (self-scoring / journal)
 * outcomes         - realised DXY reaction vs the call
 * news             - classified news / geopolitics items
 * price            - DXY price series
 * journal          - the user's own trade log
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.ts";

let db: DatabaseSync;

export function openDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(CONFIG.dbFile), { recursive: true });
  db = new DatabaseSync(CONFIG.dbFile);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, canon TEXT, currency TEXT, ts INTEGER NOT NULL, impact TEXT, forecast REAL, forecast_raw TEXT, previous REAL, previous_raw TEXT, actual REAL, actual_raw TEXT, surprise REAL, surprise_pct REAL, surprise_sign REAL, z REAL, magnitude REAL, contribution REAL, impact_score REAL, bias TEXT, note TEXT, source TEXT, updated_at INTEGER)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_events_canon_ts ON events(canon, ts)");

  d.exec("CREATE TABLE IF NOT EXISTS surprise_history (canon TEXT NOT NULL, ts INTEGER NOT NULL, diff REAL, diff_prev REAL, actual REAL, forecast REAL, previous REAL, PRIMARY KEY (canon, ts))");

  d.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, canon TEXT, event_ts INTEGER, bias TEXT, confidence REAL, stance TEXT, regime TEXT, score REAL, detail TEXT)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)");

  d.exec("CREATE TABLE IF NOT EXISTS outcomes (canon TEXT NOT NULL, event_ts INTEGER NOT NULL, horizon TEXT NOT NULL, move REAL, hit INTEGER, created_at INTEGER, PRIMARY KEY (canon, event_ts, horizon))");

  d.exec("CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, ts INTEGER, title TEXT, link TEXT, source TEXT, tier INTEGER, relevance REAL, tilt INTEGER, tags TEXT, summary TEXT)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts)");

  d.exec("CREATE TABLE IF NOT EXISTS price (symbol TEXT NOT NULL, ts INTEGER NOT NULL, price REAL, source TEXT, PRIMARY KEY (symbol, ts))");
  d.exec("CREATE INDEX IF NOT EXISTS idx_price_ts ON price(ts)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_price_symbol_ts ON price(symbol, ts)");

  // Migrate legacy price table (ts-only PK) to (symbol, ts) PK
  const priceCols = d.prepare("PRAGMA table_info(price)").all() as { name: string; pk: number }[];
  const hasSymbol = priceCols.some((c) => c.name === "symbol");
  if (!hasSymbol && priceCols.length > 0) {
    d.exec("CREATE TABLE price_new (symbol TEXT NOT NULL, ts INTEGER NOT NULL, price REAL, source TEXT, PRIMARY KEY (symbol, ts))");
    d.exec("INSERT INTO price_new(symbol, ts, price, source) SELECT 'DXY', ts, price, source FROM price");
    d.exec("DROP TABLE price");
    d.exec("ALTER TABLE price_new RENAME TO price");
    d.exec("CREATE INDEX IF NOT EXISTS idx_price_ts ON price(ts)");
    d.exec("CREATE INDEX IF NOT EXISTS idx_price_symbol_ts ON price(symbol, ts)");
  }

  d.exec("CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, canon TEXT, bias TEXT, instrument TEXT, note TEXT, result REAL)");

  d.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  for (const col of ["surprise_sign REAL", "impact_score REAL"]) {
    try {
      d.exec(`ALTER TABLE events ADD COLUMN ${col};`);
    } catch {
      /* column already exists */
    }
  }
}

export function getKv<T = unknown>(key: string): T | null {
  const row = openDb().prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}

export function setKv(key: string, value: unknown): void {
  openDb()
    .prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(key, JSON.stringify(value));
}
