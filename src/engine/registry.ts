/**
 * Canonical event registry.
 *
 * Maps raw ForexFactory-style titles onto canonical, unit-aware events with:
 *  - a DXY materiality weight (0..1)
 *  - a USD sign convention (sign = +1 -> a higher print is USD-bullish/hawkish)
 *  - an "in-line" tolerance band (native units) so 0.2% vs 0.3% is not a surprise
 *
 * The sign convention is the single most important piece of the translation layer:
 * for almost every US release a hotter number = Fed stays tight = USD stronger,
 * with the notable exceptions of jobless claims and the unemployment rate.
 */

export type EventCategory = "policy" | "inflation" | "labor" | "growth" | "energy" | "other";

export interface EventDef {
  key: string;
  label: string;
  patterns: RegExp[];
  category: EventCategory;
  /** Materiality for DXY, 0..1 */
  weight: number;
  /** +1: higher actual = USD bullish (hawkish). -1: higher actual = USD bearish. */
  sign: 1 | -1;
  /** In-line band in native units (percentage points, thousands of jobs, index points...). */
  tolerance: number;
  /** Display unit label */
  unit: string;
  /** Events without a numeric print (speeches, statements) are qualitative catalysts. */
  qualitative?: boolean;
  /** Which sub-index of the event carries the extra weight (documentation only). */
  note?: string;
}

export const EVENT_DEFS: EventDef[] = [
  // ---------------- POLICY ----------------
  {
    key: "fomc_statement",
    label: "FOMC Statement",
    patterns: [/^FOMC Statement$/i, /^FOMC Statement$/i],
    category: "policy",
    weight: 1.0,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
    note: "Anchor: rate path + balance sheet language",
  },
  {
    key: "fomc_press_conference",
    label: "FOMC Press Conference",
    patterns: [/^FOMC Press Conference/i, /^FOMC Press Conference Statement/i, /^Press Conference$/i],
    category: "policy",
    weight: 0.95,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
    note: "Tone of the Chair dominates the statement",
  },
  {
    key: "fomc_projections",
    label: "FOMC Economic Projections (SEP)",
    patterns: [/^FOMC Economic Projections/i, /^FOMC Projections/i],
    category: "policy",
    weight: 1.0,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
    note: "Median dots = direct repricing of the policy path",
  },
  {
    key: "fomc_minutes",
    label: "FOMC Meeting Minutes",
    patterns: [/^FOMC Meeting Minutes/i, /^FOMC Minutes$/i],
    category: "policy",
    weight: 0.6,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
  },
  {
    key: "fed_speech",
    label: "Fed Speech",
    patterns: [
      /^FOMC .* Speaks/i,
      /^Fed Chair .* Speaks/i,
      /^Fed (?:Governor|Vice Chair|Board Member|Chair|Member).*Speaks/i,
      /^Fed .* Testimony/i,
      /^Fed .* Testifies/i,
      /^Fed Chair .* Testimony/i,
      /^Fed [A-Z]\w+ .* Speaks/i,
    ],
    category: "policy",
    weight: 0.55,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
    note: "Scored on language (hawkish/dovish lexicon), not on numbers",
  },
  {
    key: "fed_balance_sheet",
    label: "Fed Balance Sheet",
    patterns: [/^Fed Balance Sheet/i, /^Fed Total Assets/i],
    category: "policy",
    weight: 0.25,
    sign: 1,
    tolerance: 0,
    unit: "",
  },
  {
    key: "fed_official_event",
    label: "Fed Official Event",
    patterns: [
      /^Fed Chair Nomination/i,
      /^Fed Chair Confirmation/i,
      /^Fed Vice Chair .* Nomination/i,
      /^FOMC Member .* Confirmation/i,
    ],
    category: "policy",
    weight: 0.5,
    sign: 1,
    tolerance: 0,
    unit: "",
    qualitative: true,
  },

  // ---------------- INFLATION ----------------
  {
    key: "core_cpi_mom",
    label: "Core CPI m/m",
    patterns: [/^Core CPI m\/m$/i, /^Core CPI MoM$/i],
    category: "inflation",
    weight: 0.85,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "core_cpi_yoy",
    label: "Core CPI y/y",
    patterns: [/^Core CPI y\/y$/i, /^Core CPI YoY$/i],
    category: "inflation",
    weight: 0.9,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "cpi_mom",
    label: "CPI m/m",
    patterns: [/^CPI m\/m$/i, /^CPI MoM$/i],
    category: "inflation",
    weight: 0.7,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "cpi_yoy",
    label: "CPI y/y",
    patterns: [/^CPI y\/y$/i, /^CPI YoY$/i],
    category: "inflation",
    weight: 0.8,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "core_pce_mom",
    label: "Core PCE m/m",
    patterns: [/^Core PCE Price Index m\/m$/i, /^Core PCE m\/m$/i],
    category: "inflation",
    weight: 0.85,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "core_pce_yoy",
    label: "Core PCE y/y",
    patterns: [/^Core PCE Price Index y\/y$/i, /^Core PCE y\/y$/i],
    category: "inflation",
    weight: 0.9,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "pce_mom",
    label: "PCE m/m",
    patterns: [/^PCE Price Index m\/m$/i, /^PCE m\/m$/i],
    category: "inflation",
    weight: 0.75,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "pce_yoy",
    label: "PCE y/y",
    patterns: [/^PCE Price Index y\/y$/i, /^PCE y\/y$/i],
    category: "inflation",
    weight: 0.8,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "core_ppi_mom",
    label: "Core PPI m/m",
    patterns: [/^Core PPI m\/m$/i, /^Core PPI MoM$/i],
    category: "inflation",
    weight: 0.6,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "core_ppi_yoy",
    label: "Core PPI y/y",
    patterns: [/^Core PPI y\/y$/i, /^Core PPI YoY$/i],
    category: "inflation",
    weight: 0.65,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "ppi_mom",
    label: "PPI m/m",
    patterns: [/^PPI m\/m$/i, /^PPI MoM$/i],
    category: "inflation",
    weight: 0.55,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "ppi_yoy",
    label: "PPI y/y",
    patterns: [/^PPI y\/y$/i, /^PPI YoY$/i],
    category: "inflation",
    weight: 0.6,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "import_prices",
    label: "Import Prices m/m",
    patterns: [/^Import Price Index m\/m$/i, /^Import Prices m\/m$/i],
    category: "inflation",
    weight: 0.2,
    sign: 1,
    tolerance: 0.2,
    unit: "%",
  },
  {
    key: "breakeven_inflation",
    label: "10-y Breakeven Inflation",
    patterns: [/^10-Year Breakeven Inflation Rate$/i],
    category: "inflation",
    weight: 0.2,
    sign: 1,
    tolerance: 0.05,
    unit: "%",
  },

  // ---------------- LABOR ----------------
  {
    key: "nfp",
    label: "Non-Farm Payrolls",
    patterns: [/^Non-Farm Employment Change$/i, /^Nonfarm Payrolls$/i, /^Non-Farm Payrolls$/i, /^Nonfarm Employment Change$/i],
    category: "labor",
    weight: 0.85,
    sign: 1,
    tolerance: 50,
    unit: "K",
    note: "Check unemployment rate and AHE alongside: they can offset the headline",
  },
  {
    key: "unemployment_rate",
    label: "Unemployment Rate",
    patterns: [/^Unemployment Rate$/i],
    category: "labor",
    weight: 0.8,
    sign: -1, // higher unemployment = weaker labour market = dovish read
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "ahe_mom",
    label: "Average Hourly Earnings m/m",
    patterns: [/^Average Hourly Earnings m\/m$/i, /^Average Hourly Earnings MoM$/i],
    category: "labor",
    weight: 0.6,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "ahe_yoy",
    label: "Average Hourly Earnings y/y",
    patterns: [/^Average Hourly Earnings y\/y$/i, /^Average Hourly Earnings YoY$/i],
    category: "labor",
    weight: 0.6,
    sign: 1,
    tolerance: 0.1,
    unit: "%",
  },
  {
    key: "weekly_claims",
    label: "Initial Jobless Claims",
    patterns: [/^Initial Jobless Claims$/i, /^Initial Claims$/i, /^Jobless Claims$/i, /^Unemployment Claims$/i],
    category: "labor",
    weight: 0.3,
    sign: -1, // lower claims = tighter labour market = hawkish
    tolerance: 10,
    unit: "K",
  },
  {
    key: "continuing_claims",
    label: "Continuing Jobless Claims",
    patterns: [/^Continuing Jobless Claims$/i, /^Continuing Claims$/i],
    category: "labor",
    weight: 0.2,
    sign: -1,
    tolerance: 25,
    unit: "K",
  },
  {
    key: "jolts",
    label: "JOLTS Job Openings",
    patterns: [/^JOLTS Job Openings$/i, /^JOLTS - Job Openings$/i],
    category: "labor",
    weight: 0.45,
    sign: 1,
    tolerance: 120,
    unit: "K",
  },
  {
    key: "adp",
    label: "ADP Employment Change",
    patterns: [/^ADP Employment Change$/i, /^ADP Weekly Employment Change$/i, /^ADP National Employment Report$/i, /^ADP Nonfarm Employment Change$/i],
    category: "labor",
    weight: 0.25,
    sign: 1,
    tolerance: 50,
    unit: "K",
  },

  // ---------------- GROWTH ----------------
  {
    key: "ism_mfg",
    label: "ISM Manufacturing PMI",
    patterns: [/^ISM Manufacturing PMI$/i, /^ISM Manufacturing$/i],
    category: "growth",
    weight: 0.5,
    sign: 1,
    tolerance: 1.0,
    unit: "",
  },
  {
    key: "ism_services",
    label: "ISM Services PMI",
    patterns: [/^ISM Services PMI$/i, /^ISM Services$/i, /^ISM Non-Manufacturing PMI$/i, /^ISM Non-Manufacturing$/i],
    category: "growth",
    weight: 0.5,
    sign: 1,
    tolerance: 1.0,
    unit: "",
  },
  {
    key: "retail_sales_mom",
    label: "Retail Sales m/m",
    patterns: [/^Retail Sales m\/m$/i, /^Retail Sales MoM$/i],
    category: "growth",
    weight: 0.5,
    sign: 1,
    tolerance: 0.2,
    unit: "%",
  },
  {
    key: "gdp_qoq",
    label: "GDP q/q",
    patterns: [/^GDP q\/q$/i, /^GDP QoQ$/i, /^GDP (?:QoQ|q\/q) Annualized$/i, /^Atlanta Fed GDPNow$/i],
    category: "growth",
    weight: 0.6,
    sign: 1,
    tolerance: 0.3,
    unit: "%",
  },
  {
    key: "gdp_yoy",
    label: "GDP y/y",
    patterns: [/^GDP y\/y$/i, /^GDP YoY$/i],
    category: "growth",
    weight: 0.55,
    sign: 1,
    tolerance: 0.3,
    unit: "%",
  },
  {
    key: "durable_goods",
    label: "Durable Goods Orders m/m",
    patterns: [/^Durable Goods Orders m\/m$/i, /^Durable Goods Orders MoM$/i],
    category: "growth",
    weight: 0.35,
    sign: 1,
    tolerance: 0.5,
    unit: "%",
  },
  {
    key: "industrial_production",
    label: "Industrial Production m/m",
    patterns: [/^Industrial Production m\/m$/i, /^Industrial Production MoM$/i],
    category: "growth",
    weight: 0.3,
    sign: 1,
    tolerance: 0.3,
    unit: "%",
  },
  {
    key: "consumer_confidence",
    label: "Consumer Confidence",
    patterns: [/^Consumer Confidence$/i],
    category: "growth",
    weight: 0.3,
    sign: 1,
    tolerance: 3,
    unit: "",
  },
  {
    key: "umich_sentiment",
    label: "University of Michigan Sentiment",
    patterns: [/^(?:Preliminary|Final) University of Michigan (?:Consumer Sentiment|Mood)$/i, /^University of Michigan Consumer Sentiment$/i],
    category: "growth",
    weight: 0.25,
    sign: 1,
    tolerance: 2,
    unit: "",
  },
  {
    key: "sp_global_mfg",
    label: "S&P Global Manufacturing PMI",
    patterns: [/^S&P Global Manufacturing PMI$/i],
    category: "growth",
    weight: 0.35,
    sign: 1,
    tolerance: 0.5,
    unit: "",
  },
  {
    key: "sp_global_services",
    label: "S&P Global Services PMI",
    patterns: [/^S&P Global Services PMI$/i],
    category: "growth",
    weight: 0.35,
    sign: 1,
    tolerance: 0.5,
    unit: "",
  },
  {
    key: "philly_fed",
    label: "Philly Fed Manufacturing Index",
    patterns: [/^Philly Fed Manufacturing Index$/i, /^Philadelphia Fed Manufacturing Index$/i],
    category: "growth",
    weight: 0.25,
    sign: 1,
    tolerance: 3,
    unit: "",
  },
  {
    key: "richmond_fed",
    label: "Richmond Fed Manufacturing Index",
    patterns: [/^Richmond Fed Manufacturing Index$/i, /^TLCF:Richmond$/i],
    category: "growth",
    weight: 0.2,
    sign: 1,
    tolerance: 3,
    unit: "",
  },
  {
    key: "chicago_fed",
    label: "Chicago Fed National Activity Index",
    patterns: [/^Chicago Fed National Activity Index$/i],
    category: "growth",
    weight: 0.2,
    sign: 1,
    tolerance: 0.3,
    unit: "",
  },
  {
    key: "empire_state",
    label: "Empire State Manufacturing Index",
    patterns: [/^Empire State Manufacturing Index$/i, /^NY Empire State Manufacturing Index$/i],
    category: "growth",
    weight: 0.25,
    sign: 1,
    tolerance: 3,
    unit: "",
  },
  {
    key: "construction_spending",
    label: "Construction Spending",
    patterns: [/^Construction Spending m\/m$/i, /^Construction Spending$/i],
    category: "growth",
    weight: 0.15,
    sign: 1,
    tolerance: 0.2,
    unit: "%",
  },
  {
    key: "factory_orders",
    label: "Factory Orders",
    patterns: [/^Factory Orders m\/m$/i, /^Factory Orders$/i, /^Factory orders ex transportation m\/m$/i],
    category: "growth",
    weight: 0.2,
    sign: 1,
    tolerance: 0.4,
    unit: "%",
  },
  {
    key: "new_home_sales",
    label: "New Home Sales",
    patterns: [/^New Home Sales$/i],
    category: "growth",
    weight: 0.2,
    sign: 1,
    tolerance: 30,
    unit: "K",
  },
  {
    key: "existing_home_sales",
    label: "Existing Home Sales",
    patterns: [/^Existing Home Sales$/i],
    category: "growth",
    weight: 0.2,
    sign: 1,
    tolerance: 0.2,
    unit: "M",
  },
  {
    key: "trade_balance",
    label: "Trade Balance",
    patterns: [/^Trade Balance$/i],
    category: "growth",
    weight: 0.25,
    sign: 1,
    tolerance: 5,
    unit: "B",
  },

  // ---------------- ENERGY ----------------
  {
    key: "crude_inventories",
    label: "Crude Oil Inventories",
    patterns: [/^Crude Oil Inventories$/i, /^EIA Crude Oil Inventories$/i],
    category: "energy",
    weight: 0.15,
    sign: -1, // big builds = softer energy = slightly USD-negative via inflation channel
    tolerance: 2,
    unit: "M",
  },
  {
    key: "natural_gas_storage",
    label: "Natural Gas Storage",
    patterns: [/^Natural Gas Storage$/i],
    category: "energy",
    weight: 0.1,
    sign: -1,
    tolerance: 10,
    unit: "B",
  },
];

const INDEX = new Map<string, EventDef>();
for (const d of EVENT_DEFS) INDEX.set(d.key, d);

export function defFor(key: string): EventDef | undefined {
  return INDEX.get(key);
}

/** Resolve a raw calendar title to a canonical event definition. */
export function classify(title: string): EventDef | undefined {
  const t = title.trim();
  for (const d of EVENT_DEFS) {
    for (const p of d.patterns) if (p.test(t)) return d;
  }
  return undefined;
}

/** Materiality used when the title is unknown (fallback by impact level). */
export function fallbackWeight(impact: string): number {
  switch (impact) {
    case "High":
      return 0.5;
    case "Medium":
      return 0.25;
    default:
      return 0.1;
  }
}
