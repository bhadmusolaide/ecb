/** Minimal RSS/Atom item extraction (no XML dependency). */

export interface FeedItem {
  title: string;
  link: string;
  published: number; // epoch ms, 0 when unknown
  summary: string;
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagContent(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

export function parseFeed(xml: string, fallbackSource: string): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const b of blocks) {
    const title = stripTags(tagContent(b, "title"));
    if (!title) continue;
    let link = tagContent(b, "link");
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : "";
    }
    const dateStr = tagContent(b, "pubDate") || tagContent(b, "published") || tagContent(b, "updated");
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    const summary = stripTags(tagContent(b, "description") || tagContent(b, "summary") || tagContent(b, "content"));
    const source =
      stripTags(tagContent(b, "source")) || fallbackSource || new URL(link || "https://x/").hostname;
    out.push({
      title,
      link: link.trim(),
      published: Number.isFinite(ts) ? ts : 0,
      summary: summary.slice(0, 400),
      source,
    });
  }
  return out;
}
