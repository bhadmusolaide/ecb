/**
 * CLI: quick terminal read of the current bias, the calendar, the news and the track record.
 *
 *   node src/cli.ts now
 *   node src/cli.ts events [days]
 *   node src/cli.ts news [n]
 *   node src/cli.ts stats
 *   node src/cli.ts refresh
 */
import { openDb } from "./store/db.ts";
import { buildState, refreshCalendar, refreshNews, refreshPrices, replay } from "./service/pipeline.ts";
import { fmtEtFull } from "./util/time.ts";

const cmd = process.argv[2] ?? "now";

function bar(v: number, width = 28): string {
  const filled = Math.round(Math.max(-1, Math.min(1, v)) * (width / 2));
  if (filled >= 0) return " ".repeat(width / 2) + "#".repeat(filled);
  return " ".repeat(width / 2 + filled) + "#".repeat(-filled);
}

async function main() {
  openDb();

  if (cmd === "refresh") {
    await refreshCalendar();
    await refreshNews();
    const prices = await refreshPrices();
    console.log(`refreshed (${prices.size} prices)`);
    return;
  }

  if (cmd === "news") {
    const n = Number(process.argv[3] ?? 20);
    await refreshNews();
    const s = buildState();
    console.log(`\nNEWS (${s.news.length} items)\n`);
    for (const item of s.news.slice(0, n)) {
      const tilt = item.tilt > 0 ? "USD+" : item.tilt < 0 ? "USD-" : "   ";
      console.log(`T${item.tier} ${tilt} ${item.title.slice(0, 96)}`);
    }
    return;
  }

  if (cmd === "replay") {
    const days = Number(process.argv[3] ?? 10);
    const rows = replay(days);
    console.log(`\nREPLAY (last ${days} days)\n`);
    console.log("when (ET)              event                          actual   fcst    bias      score   DXY 1h   hit");
    for (const r of rows) {
      console.log(
        `${fmtEtFull(r.ts).padEnd(22)} ${r.title.padEnd(30)} ${(r.actual || "-").padEnd(8)} ${(
          r.forecast || "-"
        ).padEnd(7)} ${r.bias.padEnd(9)} ${r.contribution.toFixed(3).padStart(6)}  ${
          r.move1h === null ? "   -   " : (r.move1h * 100).toFixed(2).padStart(6) + "%"
        }  ${r.hit === null ? " " : r.hit ? "Y" : "N"}`,
      );
    }
    const scored = rows.filter((r) => r.hit !== null);
    const hits = scored.filter((r) => r.hit === 1).length;
    console.log(
      `\nscored ${scored.length} | hits ${hits} | hit rate ${scored.length ? Math.round((hits / scored.length) * 100) : "-"}%\n`,
    );
    return;
  }

  if (cmd === "stats") {
    const s = buildState();
    console.log(JSON.stringify(s.stats, null, 2));
    return;
  }

  if (cmd === "events") {
    const days = Number(process.argv[3] ?? 3);
    const s = buildState();
    const cutoff = Date.now() + days * 86_400_000;
    console.log(`\nUSD EVENTS (next ${days}d)\n`);
    for (const e of s.events.filter((x) => x.ts > Date.now() - 3_600_000 && x.ts < cutoff)) {
      console.log(
        `${fmtEtFull(e.ts)}  ${e.impact.padEnd(6)} ${e.title.padEnd(38)} f=${(e.forecastRaw || "-").padEnd(9)} p=${(
          e.previousRaw || "-"
        ).padEnd(9)} a=${e.actualRaw || "-"}`,
      );
    }
    return;
  }

  // default: now
  const s = buildState();
  console.log(`
${"=".repeat(64)}
 ECONOMIC CALENDAR BIAS   ${s.etTime}
${"=".repeat(64)}
 DXY BIAS      ${s.bias.toUpperCase()}     (confidence ${Math.round(s.confidence * 100)}%)
 FED STANCE    ${s.stance}     REGIME: ${s.regime}
 SCORE         ${s.score > 0 ? "+" : ""}${s.score.toFixed(3)}   ${bar(s.score)}
 SESSION       ${s.session.label} (${s.session.start}-${s.session.end} ET)
  PRICE         ${Object.entries(s.prices).map(([k, v]) => `${k}: ${v.price.toFixed(3)} (${v.source})`).join("   ")}
${"-".repeat(64)}
 DRIVERS`);
  for (const d of s.drivers) console.log(`   ${d}`);
  if (s.conflicts.length) {
    console.log(" CONFLICTS");
    for (const c of s.conflicts) console.log(`   ! ${c}`);
  }
  console.log(`${"-".repeat(64)}`);
  if (s.nextEvent) {
    console.log(
      ` NEXT EVENT   ${s.nextEvent.title} in ${s.countdown} (${fmtEtFull(s.nextEvent.ts)})`,
    );
    if (s.nextEvent.preplan) {
      const pp = s.nextEvent.preplan;
      console.log(`   bullish: ${pp.bullishIf}`);
      console.log(`   bearish: ${pp.bearishIf}`);
      console.log(`   neutral: ${pp.neutralIf}`);
    }
  }
  console.log(`${"-".repeat(64)}`);
  console.log(" RECENT");
  for (const e of s.events
    .filter((x) => x.released && (x.impactScore ?? x.contribution))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6)) {
    const imp = e.impactScore ?? e.contribution ?? 0;
    console.log(
      `   ${fmtEtFull(e.ts)}  ${e.title.padEnd(34)} ${e.actualRaw || "-"} vs ${e.forecastRaw || "-"} -> ${
        e.bias
      } ${imp > 0 ? "+" : ""}${imp.toFixed(3)}`,
    );
  }
  console.log(`${"=".repeat(64)}\n`);
}

void main();
