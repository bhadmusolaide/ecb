/**
 * Pre-release decision trees.
 *
 * Replaces "watch the screen and hope" with an explicit rule: what number flips the bias,
 * in which direction, and what to watch alongside it.
 */
import type { CalEvent, Bias } from "../types.ts";
import { defFor } from "./registry.ts";

export interface PrePlan {
  canon: string;
  title: string;
  ts: number;
  forecast: number | null;
  previous: number | null;
  unit: string;
  bullishIf: string;
  bearishIf: string;
  neutralIf: string;
  watch: string[];
  expectedImpact: string;
}

const WATCH: Record<string, string[]> = {
  nfp: [
    "Unemployment rate (a rising rate alongside a hot payrolls print is a mixed, not bullish, signal)",
    "Average hourly earnings - wage momentum is the inflation input the Fed reacts to",
    "Revisions to the prior two months",
    "Participation rate",
  ],
  cpi_mom: ["Core CPI m/m (the Fed's preferred signal)", "Core CPI y/y", "Shelter and supercore components"],
  cpi_yoy: ["Core CPI m/m", "Energy and shelter components"],
  core_cpi_mom: ["Headline CPI", "Shelter / services ex-shelter", "MoM vs 3m/6m annualised trend"],
  core_cpi_yoy: ["Core CPI m/m", "Supercore services"],
  ppi_mom: ["Core PPI m/m", "PPI -> CPI pipeline read", "Goods prices"],
  ppi_yoy: ["Core PPI m/m", "Pipeline pressure into next CPI"],
  fomc_statement: [
    "Statement language vs the last meeting (dovish vs hawkish edits)",
    "Balance sheet runoff language (QT end vs continuation)",
    "Economic projections (SEP) - median 2026/2027 fed funds dots",
    "Dissents and voting split",
  ],
  fomc_press_conference: [
    "Presser tone vs the statement - the presser usually wins the second move",
    "Answer on the next meeting / path of cuts",
    "Reaction function on a hot or cold inflation print",
  ],
  fomc_minutes: ["Hawkish vs dovish split in the minutes", "Staff forecast assumptions", "Participants' disagreement"],
  unemployment_rate: ["Payrolls", "Participation rate", "Average hourly earnings"],
  weekly_claims: ["Continuing claims", "Jobless claims trend (4-week average)", "Payrolls and ADP"],
  ism_mfg: ["ISM prices paid", "New orders sub-index", "Employment sub-index"],
  ism_services: ["Prices paid", "Business activity vs new orders", "Employment sub-index"],
  retail_sales_mom: ["Control group (ex autos & gas)", "Real vs nominal", "Revisions"],
  gdp_qoq: ["Final sales to private domestic purchasers", "PCE contribution", "Consumer spending vs investment"],
};

export function buildPrePlan(ev: CalEvent): PrePlan | null {
  const def = ev.canon ? defFor(ev.canon) : undefined;
  if (!def) return null;
  const tol = def.tolerance;
  const unit = def.unit;

  const ref = ev.forecast ?? ev.previous;
  const refLabel = ev.forecast !== null ? "consensus" : "previous";

  let bullishIf: string;
  let bearishIf: string;
  let neutralIf: string;

  if (ref === null) {
    bullishIf = "no numeric consensus - read the statement/release text for the policy signal";
    bearishIf = "same";
    neutralIf = "same";
  } else {
    const half = tol > 0 ? tol * 0.5 : Math.max(Math.abs(ref) * 0.1, 0.1);
    const up = ref + half;
    const down = ref - half;
    const f = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}${unit}`;
    const signUp = def.sign === 1 ? "above" : "below";
    const signDown = def.sign === 1 ? "below" : "above";
    bullishIf = `actual ${signUp} ${f(up)} (vs ${refLabel} ${f(ref)})`;
    bearishIf = `actual ${signDown} ${f(down)} (vs ${refLabel} ${f(ref)})`;
    neutralIf = `actual between ${f(down)} and ${f(up)} - in-line, expect fade/chop`;
  }

  const impactWord =
    def.weight >= 0.8
      ? "Tier-1: can reprice the whole policy path"
      : def.weight >= 0.5
        ? "Tier-2: meaningful for the USD, usually a 1-3 hour move"
        : def.weight >= 0.25
          ? "Tier-3: secondary, mostly noise unless it surprises big"
          : "Tier-4: low materiality";

  return {
    canon: def.key,
    title: ev.title,
    ts: ev.ts,
    forecast: ev.forecast,
    previous: ev.previous,
    unit,
    bullishIf,
    bearishIf,
    neutralIf,
    watch: WATCH[def.key] ?? ["Related secondary releases", "Rate expectations (FedWatch)", "US yields"],
    expectedImpact: impactWord,
  };
}

export function biasFromActual(
  ev: CalEvent,
  actual: number,
): { bias: Bias; reason: string } {
  const def = ev.canon ? defFor(ev.canon) : undefined;
  if (!def) return { bias: "Neutral", reason: "Unclassified event" };
  const ref = ev.forecast ?? ev.previous;
  if (ref === null) return { bias: "Neutral", reason: "No consensus to compare" };
  const tol = def.tolerance || Math.max(Math.abs(ref) * 0.1, 0.1);
  const diff = actual - ref;
  if (Math.abs(diff) <= tol * 0.5) {
    return { bias: "Neutral", reason: `In line with ${ev.forecast !== null ? "consensus" : "previous"}` };
  }
  const hawkish = def.sign === 1 ? diff > 0 : diff < 0;
  return {
    bias: hawkish ? "Bullish" : "Bearish",
    reason: hawkish
      ? `Above expectations (${diff > 0 ? "+" : ""}${Math.round(diff * 100) / 100}${def.unit}) - USD supportive`
      : `Below expectations (${diff > 0 ? "+" : ""}${Math.round(diff * 100) / 100}${def.unit}) - USD negative`,
  };
}
