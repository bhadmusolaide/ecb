/**
 * Session-aware scheduler.
 *
 * Poll intensity follows the market clock:
 *   - a high-impact release inside 30 minutes  -> tight loop (the actual is about to land)
 *   - inside an active session                 -> normal loop
 *   - off hours                                -> relaxed loop
 */
import { CONFIG } from "../config.ts";
import { sessionFor, isActiveSession } from "../util/time.ts";
import * as q from "../store/queries.ts";
import {
  refreshCalendar,
  refreshNews,
  refreshPrices,
  analyzeEvents,
  logNewCalls,
  updateOutcomes,
  seedPriceHistory,
} from "./pipeline.ts";

export interface PollPlan {
  calendarMs: number;
  newsMs: number;
  priceMs: number;
  reason: string;
}

export function planFor(now: number, events: { ts: number; impact: string }[]): PollPlan {
  const nextHigh = events
    .filter((e) => e.ts > now && e.impact === "High")
    .sort((a, b) => a.ts - b.ts)[0];
  const msToHigh = nextHigh ? nextHigh.ts - now : Infinity;

  if (msToHigh <= 30 * 60_000) {
    return {
      calendarMs: CONFIG.poll.nearEventCalendar,
      newsMs: CONFIG.poll.newsFast,
      priceMs: CONFIG.poll.priceFast,
      reason: `High-impact release in ${Math.round(msToHigh / 60000)} min`,
    };
  }
  if (isActiveSession(now)) {
    return {
      calendarMs: CONFIG.poll.activeCalendar,
      newsMs: CONFIG.poll.news,
      priceMs: CONFIG.poll.price,
      reason: `Active session (${sessionFor(now)})`,
    };
  }
  return {
    calendarMs: CONFIG.poll.idleCalendar,
    newsMs: CONFIG.poll.news * 3,
    priceMs: CONFIG.poll.price * 5,
    reason: "Off hours",
  };
}

type Task = "calendar" | "news" | "price";

export class Scheduler {
  private running = false;
  private last: Record<Task, number> = { calendar: 0, news: 0, price: 0 };
  private timer: NodeJS.Timeout | null = null;
  public lastPlan: PollPlan | null = null;
  public lastError: string | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await seedPriceHistory().catch(() => 0);
    await this.tick(true);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick(false).finally(() => this.schedule());
    }, 2000);
    this.timer.unref?.();
  }

  async tick(force = false): Promise<void> {
    const now = Date.now();
    const events = q.getEventsSince(now - 6 * 3_600_000);
    const plan = planFor(now, events);
    this.lastPlan = plan;

    const due = (task: Task, interval: number) => force || now - this.last[task] >= interval;

    if (due("calendar", plan.calendarMs)) {
      try {
        await refreshCalendar(now);
        this.last.calendar = Date.now();
        this.lastError = null;
      } catch (err) {
        this.lastError = (err as Error).message;
        console.warn("[scheduler] calendar:", this.lastError);
      }
    }
    if (due("news", plan.newsMs)) {
      try {
        await refreshNews(now);
        this.last.news = Date.now();
      } catch (err) {
        console.warn("[scheduler] news:", (err as Error).message);
      }
    }
    if (due("price", plan.priceMs)) {
      try {
        await refreshPrices(now);
        this.last.price = Date.now();
      } catch (err) {
        console.warn("[scheduler] price:", (err as Error).message);
      }
    }

    analyzeEvents(now);
    logNewCalls(now);
    updateOutcomes(now);
  }
}

export const scheduler = new Scheduler();
