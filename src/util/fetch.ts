/** Small fetch helpers: timeout, retry, UA, JSON/text, plus per-host rate-limit backoff. */

export class RateLimitError extends Error {
  url: string;
  status: number;
  constructor(url: string, status: number) {
    super(`rate limited (${status}) for ${url}`);
    this.name = "RateLimitError";
    this.url = url;
    this.status = status;
  }
}

const cooldowns = new Map<string, number>();

export function isCoolingDown(url: string): boolean {
  const host = hostOf(url);
  const until = cooldowns.get(host) ?? 0;
  return Date.now() < until;
}

export function coolDown(url: string, ms: number): void {
  const host = hostOf(url);
  cooldowns.set(host, Date.now() + ms);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function fetchText(
  url: string,
  opts: {
    timeoutMs?: number;
    retries?: number;
    headers?: Record<string, string>;
    cooldownMs?: number;
  } = {},
): Promise<string> {
  const { timeoutMs = 15000, retries = 2, headers = {}, cooldownMs = 120_000 } = opts;
  if (isCoolingDown(url)) throw new RateLimitError(url, 429);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; EconomicCalendarBias/1.0)",
          ...headers,
        },
      });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        coolDown(url, cooldownMs * (attempt + 1));
        throw new RateLimitError(url, res.status);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err instanceof RateLimitError) break; // do not hammer a cooling host
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const txt = await fetchText(url, opts);
  return JSON.parse(txt) as T;
}

/**
 * Some hosts (ForexFactory behind Cloudflare) block Node's TLS/undici fingerprint but serve
 * curl happily. This routes such requests through curl, which behaves like a real browser.
 */
export async function curlGet(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<string> {
  const { timeoutMs = 20000, headers = {} } = opts;
  const args = ["-sSL", "--compressed", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push(url);

  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

  const idx = out.lastIndexOf("\n");
  const status = Number(out.slice(idx + 1).trim());
  const body = out.slice(0, idx);
  if (status === 403 || status === 429 || status === 503) throw new RateLimitError(url, status);
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${url}`);
  return body;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
