/**
 * News + geopolitics aggregator and classifier.
 *
 * Rules-based classification (relevance to DXY, directional tilt, severity tier).
 * The optional LLM analyst layer can add nuance on top of these tags, but never
 * replaces them.
 */
import { fetchText } from "../../util/fetch.ts";
import { parseFeed } from "../../util/xml.ts";
import type { FeedItem } from "../../util/xml.ts";
import type { NewsItem } from "../../types.ts";

export interface FeedSpec {
  name: string;
  url: string;
}

export const FEEDS: FeedSpec[] = [
  { name: "Fed Press", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { name: "Guardian World", url: "https://www.theguardian.com/world/rss" },
  { name: "GN: Federal Reserve", url: gnews("Federal Reserve") },
  { name: "GN: Dollar Index", url: gnews("dollar index OR DXY") },
  { name: "GN: US Inflation", url: gnews("US inflation CPI Federal Reserve rates") },
  { name: "GN: Jobs Report", url: gnews("US jobs report payrolls unemployment") },
  { name: "GN: Geopolitics", url: gnews("(war OR sanctions OR tariff OR ceasefire OR OPEC) markets") },
  { name: "GN: Treasury Yields", url: gnews("Treasury yields dollar") },
];

function gnews(q: string): string {
  const encoded = encodeURIComponent(q);
  return `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
}

const RELEVANCE_GROUPS: RegExp[][] = [
  [/federal reserve|\bfomc\b|\bpowell\b/i],
  [/\bdollar\b|\bdxy\b|greenback/i],
  [/\bcpi\b|\binflation\b|\bppi\b|\bpc(e|ce)\b/i],
  [/payroll|jobs report|unemployment|nonfarm/i],
  [/treasury|yield|bond auction/i],
  [/ecb|\bboj\b|\bpboc\b|central bank/i],
  [/tariff|sanction|export control/i],
  [/oil|crude|opec|energy price/i],
  [/\bgdp\b|\brecession\b|\bunemployment rate\b|\bism\b/i],
  [/\bgeopolit|conflict|strike|invasion|military/i],
];

const USD_BULL: [RegExp, number][] = [
  [/\bhawkish\b/i, 2],
  [/rate hike|higher for longer|raise(?:d|s)? rates|upside surprise/i, 2],
  [/\bhotter than expected|inflation (?:acceleration|accelerates|rises|rose|hot|elevated|sticky)/i, 1.6],
  [/\bfed (?:keeps|holds|signals|warns|declares)/i, 0.8],
  [/war|invasion|missile|strike on|airstrike|military escalation|ceasefire (?:breaks|collapses|ends)/i, 2],
  [/sanction|tariff|export control|embargo/i, 1.6],
  [/\bdefault\b|downgrade|sovereign crisis|bank failure|systemic/i, 2],
  [/flight to safety|safe-haven|safe haven|risk-off|risk off|sell-?off|panic/i, 1.6],
  [/\bsupply (?:shock|disruption)|opec\+? ?cut/i, 1.2],
  [/\bgovernment shutdown\b/i, 0.8],
  [/\bstagflation\b/i, 0.8],
];

const USD_BEAR: [RegExp, number][] = [
  [/\bdovish\b/i, -2],
  [/rate cut|cut(?:ting)? (?:interest )?rates|lower(?:ing)? rates|trimming\b/i, -2],
  [/\bstimulus\b|\bfiscal support|\bbailout/i, -1.2],
  [/\bsoft landing\b|\bcooling\b|\beasing\b|\bdisinflation\b/i, -1],
  [/cooler than expected|miss(?:ed)? (?:expectations|forecast)|weaker than expected/i, -1.6],
  [/\brecession\b|\bslowdown\b|\bcontraction\b/i, -1.2],
  [/\bslack\b|\bweak labor|layoffs/i, -1],
  [/\bfed (?:eases|signals cuts|backs off)/i, -1],
];

const TIER1: RegExp[] = [
  /war|invasion|missile|airstrike|military (?:escalation|strike)|ceasefire (?:breaks|collapses)/i,
  /sanction|tariff|export control|embargo/i,
  /\bdefault\b|downgrade|sovereign crisis|bank failure|systemic (?:crisis|risk)/i,
  /emergency (?:rate )?(?:cut|hike|meeting)|unscheduled (?:meeting|announcement)/i,
  /opec\+? ?cut|supply (?:shock|disruption)/i,
  /government shutdown|debt ceiling (?:impasse|breach)/i,
];

const TIER2: RegExp[] = [
  /federal reserve|\bfomc\b|\bpowell\b|\bdot plot\b/i,
  /\bdollar\b|\bdxy\b|greenback/i,
  /\bcpi\b|\binflation\b|\bppi\b|\bcore pce\b/i,
  /payroll|jobs report|nonfarm|unemployment rate/i,
  /treasury|yield curve|bond auction/i,
  /\becb\b|\bboj\b|central bank/i,
  /\bgdp\b|\bism\b/i,
];

export function classifyHeadline(item: FeedItem): {
  tier: number;
  relevance: number;
  tilt: number;
  tags: string[];
} {
  const text = `${item.title} ${item.summary}`;
  const tags: string[] = [];

  let groups = 0;
  for (const g of RELEVANCE_GROUPS) {
    if (g.some((re) => re.test(text))) {
      groups++;
      tags.push(g[0].source.slice(0, 24));
    }
  }
  const relevance = Math.min(1, groups / 3);

  let bull = 0;
  for (const [re, w] of USD_BULL) if (re.test(text)) bull += w;
  let bear = 0;
  for (const [re, w] of USD_BEAR) if (re.test(text)) bear += w;
  const net = bull + bear;
  let tilt = 0;
  if (net >= 1.5) tilt = 1;
  else if (net <= -1.5) tilt = -1;
  if (bull > 0) tags.push("USD+");
  if (bear > 0) tags.push("USD-");

  let tier = 3;
  if (TIER1.some((re) => re.test(text))) tier = 1;
  else if (TIER2.some((re) => re.test(text)) || groups >= 2) tier = 2;

  return { tier, relevance: Math.round(relevance * 100) / 100, tilt, tags };
}

export function newsId(title: string, link: string): string {
  const base = `${title}|${link}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 120);
  let h = 5381;
  const s = `${title}|${link}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${base}-${h.toString(36)}`;
}

/** Per-feed pacing so we never hammer a publisher. */
const lastFetch = new Map<string, number>();
const MIN_INTERVAL_MS = 60_000;

export async function fetchAllNews(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const last = lastFetch.get(feed.url) ?? 0;
      if (Date.now() - last < MIN_INTERVAL_MS) throw new Error(`feed ${feed.name} on cooldown`);
      const xml = await fetchText(feed.url, { timeoutMs: 12000, retries: 1 });
      lastFetch.set(feed.url, Date.now());
      return parseFeed(xml, feed.name).map((i) => ({ feed: feed.name, item: i }));
    }),
  );

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const { feed, item } of r.value) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 70);
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = classifyHeadline(item);
      items.push({
        id: newsId(item.title, item.link),
        ts: item.published || Date.now(),
        title: item.title,
        link: item.link,
        source: item.source || feed,
        tier: cls.tier,
        relevance: cls.relevance,
        tilt: cls.tilt,
        tags: cls.tags,
        summary: item.summary,
      });
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, 250);
}
