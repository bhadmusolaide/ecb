/**
 * Optional LLM analyst layer.
 *
 * Rules stay in charge of the numbers; the model is only allowed to enrich qualitative
 * judgements (Fed tone, headline interpretation). Every call is validated against a strict
 * JSON contract and logged, so a disagreement with the rules becomes calibration data
 * instead of a silent override.
 */
import { CONFIG } from "../config.ts";

export interface LlmAvailable {
  enabled: boolean;
  model: string;
}

export function llmAvailable(): LlmAvailable {
  return { enabled: Boolean(CONFIG.llm.apiKey), model: CONFIG.llm.model };
}

async function chatJson(system: string, user: string): Promise<unknown | null> {
  if (!CONFIG.llm.apiKey) return null;
  const url = `${CONFIG.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONFIG.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.llm.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    console.warn("[llm] call failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface FedToneRead {
  stance: "Hawkish" | "Dovish" | "Neutral";
  score: number; // -1..+1
  summary: string;
  keyChanges: string[];
}

/** Score a Fed statement / presser transcript for policy tone. */
export async function readFedTone(text: string, label: string): Promise<FedToneRead | null> {
  const sys = `You are a senior macro strategist covering the Federal Reserve.
Interpret the policy tone of the text below for the US dollar (DXY).
Return ONLY JSON: {"stance":"Hawkish|Dovish|Neutral","score":number_between_-1_and_1,"summary":string_max_220_chars,"keyChanges":[string,string]}.
score: +1 = clearly hawkish (tighter policy, USD upside), -1 = clearly dovish (easier policy, USD downside).
Base it on the policy path, inflation language, and reaction function. Be precise and unsentimental.`;
  const user = `Document: ${label}\n\n${text.slice(0, 12000)}`;
  const out = (await chatJson(sys, user)) as FedToneRead | null;
  if (!out || typeof out.score !== "number") return null;
  return {
    stance: out.stance ?? "Neutral",
    score: Math.max(-1, Math.min(1, out.score)),
    summary: String(out.summary ?? "").slice(0, 300),
    keyChanges: Array.isArray(out.keyChanges) ? out.keyChanges.slice(0, 4).map(String) : [],
  };
}

export interface HeadlineRead {
  tilt: number; // -1, 0, +1 for DXY
  tier: number; // 1, 2, 3
  relevance: number; // 0..1
  reason: string;
}

/** Second opinion on a news headline the rules could not classify. */
export async function readHeadline(title: string, context = ""): Promise<HeadlineRead | null> {
  const sys = `You classify market news for a USD (DXY) trading bias.
Return ONLY JSON: {"tilt":-1|0|1,"tier":1|2|3,"relevance":0..1,"reason":string_max_160_chars}.
tilt +1 = USD bullish (hawkish Fed, hotter inflation, risk-off flight to safety, geopolitical escalation),
tilt -1 = USD bearish (dovish Fed, cooler inflation, risk-on, easing policy),
tilt 0 = no clear DXY implication.
tier 1 = market moving, 2 = macro relevant, 3 = background.`;
  const user = `Headline: ${title}\n${context ? `Context: ${context}` : ""}`;
  const out = (await chatJson(sys, user)) as HeadlineRead | null;
  if (!out || typeof out.tilt !== "number") return null;
  return {
    tilt: Math.max(-1, Math.min(1, Math.round(out.tilt))),
    tier: Math.max(1, Math.min(3, Math.round(out.tier ?? 2))),
    relevance: Math.max(0, Math.min(1, Number(out.relevance ?? 0.5))),
    reason: String(out.reason ?? "").slice(0, 200),
  };
}
