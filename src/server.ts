/**
 * HTTP server: JSON API + static dashboard.
 * Zero dependencies (node:http).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG } from "./config.ts";
import { buildState, refreshCalendar, refreshNews, refreshPrices, computeStats } from "./service/pipeline.ts";
import { scheduler } from "./service/scheduler.ts";
import { openDb } from "./store/db.ts";
import { addJournal, getJournal } from "./store/queries.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
      if (p === "/api/state") {
        sendJson(res, 200, buildState());
        return;
      }
      if (p === "/api/stats") {
        sendJson(res, 200, computeStats());
        return;
      }
      if (p === "/api/news") {
        const state = buildState();
        sendJson(res, 200, { news: state.news, tilt: state.sources });
        return;
      }
      if (p === "/api/journal" && req.method === "GET") {
        sendJson(res, 200, { entries: getJournal(200) });
        return;
      }
      if (p === "/api/journal" && req.method === "POST") {
        const body = await readBody(req);
        addJournal({
          ts: Date.now(),
          canon: typeof body.canon === "string" ? body.canon : null,
          bias: typeof body.bias === "string" ? body.bias : "Neutral",
          instrument: typeof body.instrument === "string" ? body.instrument : "DXY",
          note: typeof body.note === "string" ? body.note : "",
          result: typeof body.result === "number" ? body.result : null,
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (p === "/api/refresh" && req.method === "POST") {
        const [cal, news, prices] = await Promise.all([
          refreshCalendar(),
          refreshNews(),
          refreshPrices(),
        ]);
        sendJson(res, 200, { ok: true, calendar: cal, news, prices: prices.size });
        return;
      }
      if (p === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          plan: scheduler.lastPlan,
          error: scheduler.lastError,
          sources: buildState().sources,
        });
        return;
      }
      if (serveStatic(res, p)) return;
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[server]", err);
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export async function start(): Promise<void> {
  openDb();
  const server = createServer();
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`Economic Calendar Bias  ->  http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`price provider: ${CONFIG.priceProvider}  |  llm: ${CONFIG.llm.model}`);
  });
  // The first refresh hits the network, so it must not block the listener.
  void scheduler.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start();
}
