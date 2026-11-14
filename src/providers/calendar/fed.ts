/**
 * Federal Reserve provider.
 *
 * The calendar gives us the schedule (ForexFactory); the Fed gives us the *text* of
 * statements, minutes and speeches, which is what the hawkish/dovish lexicon scores.
 */
import { fetchText } from "../../util/fetch.ts";
import { parseFeed } from "../../util/xml.ts";
import type { FeedItem } from "../../util/xml.ts";
import { scoreText } from "../../engine/lexicon.ts";

export interface FedDoc {
  title: string;
  link: string;
  ts: number;
  kind: "statement" | "minutes" | "speech" | "other";
  text: string;
  lex: number;
  lexTerms: string[];
}

const FEED_URLS: [string, FedDoc["kind"]][] = [
  ["https://www.federalreserve.gov/feeds/press_monetary.xml", "statement"],
  ["https://www.federalreserve.gov/feeds/press_all.xml", "other"],
  ["https://www.federalreserve.gov/feeds/speeches.xml", "speech"],
];

function kindFromTitle(title: string, fallback: FedDoc["kind"]): FedDoc["kind"] {
  const t = title.toLowerCase();
  if (t.includes("minutes")) return "minutes";
  if (t.includes("statement") || t.includes("implementation note") || t.includes("federal open market committee")) {
    return "statement";
  }
  if (t.includes("speech") || t.includes("testimony") || t.includes("remarks") || t.includes("exchange")) {
    return "speech";
  }
  return fallback;
}

export async function fetchFedDocs(maxDocs = 12): Promise<FedDoc[]> {
  const docs: FedDoc[] = [];
  const seen = new Set<string>();

  for (const [url, fallbackKind] of FEED_URLS) {
    let items: FeedItem[] = [];
    try {
      const xml = await fetchText(url, { timeoutMs: 12000, retries: 1 });
      items = parseFeed(xml, "Federal Reserve");
    } catch {
      continue;
    }
    for (const item of items.slice(0, 12)) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      const kind = kindFromTitle(item.title, fallbackKind);
      const ts = item.published || Date.parse(item.link) || Date.now();
      let text = "";
      if (kind === "statement" || kind === "speech") {
        text = await fetchArticleText(item.link);
      }
      const lex = scoreText(`${item.title} ${text || item.summary}`);
      docs.push({
        title: item.title,
        link: item.link,
        ts,
        kind,
        text: text || item.summary,
        lex: lex.score,
        lexTerms: lex.matched,
      });
    }
  }

  docs.sort((a, b) => b.ts - a.ts);
  return docs.slice(0, maxDocs);
}

async function fetchArticleText(link: string): Promise<string> {
  try {
    const html = await fetchText(link, { timeoutMs: 12000, retries: 1 });
    const body =
      html.match(/<div[^>]+id=["']article["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ??
      html.match(/<div[^>]+class=["'][^"']*col-xs-12[^"']*col-sm-8[^"']*["'][^>]*>([\s\S]*?)<footer/i)?.[1] ??
      html;
    const text = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 20000);
  } catch {
    return "";
  }
}
