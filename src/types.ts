/** Shared domain types. */

export type Bias = "Bullish" | "Bearish" | "Neutral";
export type Stance = "Hawkish" | "Dovish" | "Neutral";
export type Regime = "Choppy" | "Trending" | "Neutral";

export interface CalEvent {
  id: string;
  title: string;
  canon: string | null;
  canonLabel: string | null;
  currency: string;
  ts: number;
  impact: string;
  forecast: number | null;
  forecastRaw: string;
  previous: number | null;
  previousRaw: string;
  actual: number | null;
  actualRaw: string;
  /** actual - forecast (native units) */
  surprise: number | null;
  /** (actual - forecast) / |forecast| * 100 */
  surprisePct: number | null;
  /** standardised surprise vs history of the same event */
  z: number | null;
  /** direction of the surprise: +1 above consensus, -1 below, 0 in line */
  surpriseSign: number | null;
  /** 0..1 normalised magnitude */
  magnitude: number | null;
  /** signed contribution to the session score (decayed by age) */
  contribution: number | null;
  /** signed impact of the release itself, without the time decay */
  impactScore: number | null;
  /** per-event bias: Bullish / Bearish / Neutral (USD) */
  bias: Bias | null;
  /** qualitative note (lexicon, LLM rationale) */
  note: string | null;
  source: string;
  released: boolean;
}

export interface NewsItem {
  id: string;
  ts: number;
  title: string;
  link: string;
  source: string;
  /** 1 = market-moving, 2 = macro relevant, 3 = background */
  tier: number;
  /** 0..1 relevance to DXY */
  relevance: number;
  /** +1 USD bullish, -1 USD bearish, 0 neutral/unknown */
  tilt: number;
  tags: string[];
  summary: string;
}

export interface PricePoint {
  symbol: string;
  ts: number;
  price: number;
  source: string;
}
