/**
 * Hawkish / dovish lexicon.
 *
 * Used for qualitative events (FOMC statement, press conference, Fed speeches) and for
 * news headlines that the rules cannot classify from numbers alone.
 * Positive score = hawkish (USD supportive). Negative = dovish (USD negative).
 */

const HAWKISH: [RegExp, number][] = [
  [/\bhawkish\b/i, 1.6],
  [/\bfurther (?:rate )?(?:hikes?|tightening)\b/i, 1.4],
  [/\b(?:additional|more) (?:rate )?hikes?\b/i, 1.4],
  [/\braise(?:d|s)? (?:the )?(?:target )?rate/i, 1.2],
  [/\bhigher for longer\b/i, 1.2],
  [/\bnot (?:confident|in a hurry|ready)\b/i, 1.0],
  [/\bno urgency\b/i, 0.9],
  [/\binflation (?:remains|is) (?:elevated|sticky|persistent|hot|high)\b/i, 1.2],
  [/\bprice pressures?\b/i, 0.7],
  [/\babove (?:our )?target\b/i, 0.8],
  [/\bresilient\b/i, 0.7],
  [/\brestrictive\b/i, 0.6],
  [/\btightening\b/i, 0.6],
  [/\btight(?:er)?\b/i, 0.4],
  [/\bbalance sheet runoff\b/i, 0.4],
  [/\bupside risks? to (?:growth|inflation)\b/i, 0.8],
  [/\bstrong(?:er)? (?:growth|demand|jobs|job market)\b/i, 0.6],
  [/\bdeliberately\b/i, 0.2],
  [/\bcertain\b/i, 0.4],
];

const DOVISH: [RegExp, number][] = [
  [/\bdovish\b/i, -1.6],
  [/\b(?:rate )?cuts?\b/i, -1.2],
  [/\bcutting (?:rates|interest)\b/i, -1.3],
  [/\blower(?:ing)? (?:rates|interest rates)\b/i, -1.2],
  [/\baccommodative\b/i, -1.0],
  [/\bpatient\b/i, -0.9],
  [/\bgradual(?:ly)?\b/i, -0.7],
  [/\beasing\b/i, -0.7],
  [/\bdisinflation\b/i, -0.9],
  [/\bbelow (?:our )?target\b/i, -0.9],
  [/\bsoft landing\b/i, -0.6],
  [/\bpause\b/i, -0.6],
  [/\binsurance (?:cut|rate cut)\b/i, -1.3],
  [/\bstimulus\b/i, -0.8],
  [/\bsupport (?:the )?economy\b/i, -0.6],
  [/\brecession risk\b/i, -0.5],
  [/\bweaker (?:than expected|labour|labor|growth)\b/i, -0.8],
  [/\bcooling\b/i, -0.5],
];

export interface LexScore {
  score: number; // >0 hawkish, <0 dovish
  matched: string[];
}

export function scoreText(text: string): LexScore {
  if (!text) return { score: 0, matched: [] };
  let score = 0;
  const matched: string[] = [];
  for (const [re, w] of HAWKISH) {
    if (re.test(text)) {
      score += w;
      matched.push(re.source.slice(0, 60));
    }
  }
  for (const [re, w] of DOVISH) {
    if (re.test(text)) {
      score += w;
      matched.push(re.source.slice(0, 60));
    }
  }
  // squash into -3..3 so a long document does not dominate a short one
  const squashed = 3 * Math.tanh(score / 3);
  return { score: Math.round(squashed * 1000) / 1000, matched };
}

export function stanceFromScore(score: number): "Hawkish" | "Dovish" | "Neutral" {
  if (score >= 0.6) return "Hawkish";
  if (score <= -0.6) return "Dovish";
  return "Neutral";
}
