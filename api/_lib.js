// Shared helpers for the serverless functions: Gemini call, Supabase REST, scoring.
import { createHash, randomUUID } from "node:crypto";

export const LEVELS = ["below_usual", "around_usual", "above_usual", "breakout"];

export const FACTORS = [
  { key: "hook", label: "Hook (first 3 seconds)", weight: 0.25 },
  { key: "retention", label: "Pacing & retention", weight: 0.15 },
  { key: "clarity", label: "Message clarity & value", weight: 0.15 },
  { key: "visual", label: "Visual quality", weight: 0.10 },
  { key: "audio", label: "Audio & voice", weight: 0.08 },
  { key: "text", label: "On-screen text & captions", weight: 0.07 },
  { key: "ending", label: "Ending, CTA & rewatch", weight: 0.08 },
  { key: "caption", label: "Caption & hashtags", weight: 0.05 },
  { key: "shareability", label: "Shareability & trend fit", weight: 0.07 },
];

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function newId() {
  return randomUUID();
}

export function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim();
  return ip || req.socket?.remoteAddress || "unknown";
}

export function hashIp(ip) {
  const salt = process.env.RATE_SALT || "reelradar";
  return createHash("sha256").update(salt + "|" + ip).digest("hex").slice(0, 32);
}

// ---------- Supabase (plain REST, no SDK) ----------

export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function sbInsert(table, row) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase insert ${table} failed: ${r.status} ${await r.text()}`);
}

export async function sbCount(table, filters) {
  const qs = new URLSearchParams({ select: "id", ...filters }).toString();
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: sbHeaders({ Prefer: "count=exact", Range: "0-0" }),
  });
  if (!r.ok) throw new Error(`Supabase count ${table} failed: ${r.status} ${await r.text()}`);
  const range = r.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

export async function sbSelectOne(table, filters) {
  const qs = new URLSearchParams({ select: "*", limit: "1", ...filters }).toString();
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase select ${table} failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || null;
}

// ---------- Gemini ----------

const REPORT_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "2-3 sentence honest verdict for the creator." },
    predicted_level: { type: "STRING", enum: LEVELS },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    hook_starts_at_seconds: { type: "NUMBER", description: "Second at which the real hook/payoff promise appears. 0 if immediate." },
    has_text_on_screen: { type: "BOOLEAN" },
    has_speech: { type: "BOOLEAN" },
    has_music: { type: "BOOLEAN" },
    detected_topic: { type: "STRING" },
    detected_format: { type: "STRING", description: "e.g. talking head, tutorial, vlog, skit, montage, before/after, POV, listicle" },
    factors: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING", enum: FACTORS.map((f) => f.key) },
          score: { type: "INTEGER", description: "0-100" },
          verdict: { type: "STRING", description: "One-line verdict" },
          detail: { type: "STRING", description: "2-4 sentences: what you observed, with timestamps where useful, and why it matters." },
        },
        required: ["key", "score", "verdict", "detail"],
      },
    },
    working_well: { type: "ARRAY", items: { type: "STRING" } },
    top_fixes: {
      type: "ARRAY",
      description: "3 highest-impact fixes, most important first",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          how: { type: "STRING", description: "Concrete, specific instruction the creator can act on today." },
          impact: { type: "STRING", enum: ["high", "medium", "low"] },
        },
        required: ["title", "how", "impact"],
      },
    },
    timeline_notes: {
      type: "ARRAY",
      description: "Moment-by-moment notes at specific timestamps (attention drops, strong moments)",
      items: {
        type: "OBJECT",
        properties: {
          at_seconds: { type: "NUMBER" },
          note: { type: "STRING" },
          kind: { type: "STRING", enum: ["strength", "risk", "suggestion"] },
        },
        required: ["at_seconds", "note", "kind"],
      },
    },
    hook_rewrites: { type: "ARRAY", description: "3 alternative opening lines / on-screen hook texts", items: { type: "STRING" } },
    caption_rewrite: { type: "STRING" },
    hashtags: { type: "ARRAY", items: { type: "STRING" } },
    best_posting_window: { type: "STRING", description: "Short suggestion on when to post for this niche/audience, with the reasoning." },
  },
  required: [
    "summary", "predicted_level", "confidence", "hook_starts_at_seconds", "has_text_on_screen", "has_speech", "has_music",
    "detected_topic", "detected_format", "factors", "working_well", "top_fixes", "timeline_notes", "hook_rewrites",
    "caption_rewrite", "hashtags", "best_posting_window",
  ],
};

const LANG_NAMES = { en: "English", hinglish: "Hinglish (Hindi written in Latin letters, mixed with English, casual creator tone)", hi: "Hindi (Devanagari script)" };

export function buildPrompt(meta) {
  const lang = LANG_NAMES[meta.language] || LANG_NAMES.en;
  const usual = meta.usual_views ? `${meta.usual_views} views` : "unknown";
  const followers = meta.followers ? String(meta.followers) : "unknown";
  return `You are ReelRadar, a brutally honest but constructive short-form video strategist. You have studied thousands of Instagram Reels, YouTube Shorts and TikToks and you know what makes people stop scrolling, keep watching, share and rewatch.

You are given evidence extracted from a reel BEFORE it is posted:
- Frames sampled from the video (timestamps are given before each frame; the first 3 seconds are sampled densely because the hook decides everything).
- The audio track${meta.has_audio ? ` (first ${Math.round(meta.audio_seconds)} seconds${meta.audio_seconds < meta.duration ? " only" : ""})` : " is MISSING or silent"}.
- Creator-provided context below.

CREATOR CONTEXT
- Niche: ${meta.niche}
- Video length: ${meta.duration.toFixed(1)} seconds, ${meta.width}x${meta.height} (${meta.orientation})
- Followers: ${followers}
- Usual views per reel: ${usual}
- Will add music inside the Instagram app after upload: ${meta.will_add_music ? "yes (so judge the audio you hear as the raw voice/sound track, not the final music)" : "no"}
- Planned caption: ${meta.caption ? JSON.stringify(meta.caption) : "(none given)"}
- Planned hashtags: ${meta.hashtags ? JSON.stringify(meta.hashtags) : "(none given)"}

HOW TO JUDGE
1. Hook: Does something in the first 1-2 seconds create curiosity, tension, a bold claim, a visual surprise, or a clear promise? Late hooks (after 3s) lose most viewers. Face + movement + on-screen text in frame 1 usually helps.
2. Retention: pacing, cuts, visual change, whether there is a reason to keep watching, dead air, slow intros, repeated points.
3. Clarity & value: is the point obvious? would the target viewer learn, laugh, feel something, or relate?
4. Visual: lighting, framing, vertical fit (9:16), sharpness, clutter, watermark/logo problems.
5. Audio: voice clarity, energy, volume, music fit, silence.
6. Text & captions: readable on-screen text, subtitles for sound-off viewers, text not covered by Instagram UI (bottom 20% and right edge).
7. Ending: payoff, loop potential, CTA that is not needy, rewatch trigger.
8. Caption & hashtags: caption that adds a hook or context, 3-8 relevant hashtags, no banned or spammy tags.
9. Shareability & trend fit: would someone send this to a friend? does it match a current format that works in this niche?

PREDICTION RULES
- predicted_level compares this reel to THIS creator's usual performance, not to viral reels in general.
- "breakout" is rare: reserve it for reels with a very strong hook, high shareability and clear value. Most decent reels are "around_usual" or "above_usual".
- Be honest. A mediocre reel should get a mediocre score. Creators lose trust in flattery.
- Scores: 0-100 per factor. 50 = average reel in this niche. 80+ = genuinely strong. Under 35 = a real problem.
- Confidence: "low" if the audio is missing or the video is very short/unclear, otherwise "medium"; "high" only when the evidence is clearly consistent.

OUTPUT RULES
- Write every text field in ${lang}. Keep the JSON keys in English.
- Be specific: reference timestamps ("at 0:04 the ..."), what you actually saw/heard, and give fixes the creator can do today.
- Include exactly one entry per factor key: ${FACTORS.map((f) => f.key).join(", ")}.
- top_fixes: exactly 3. hook_rewrites: exactly 3. timeline_notes: 3-6 entries.
- If audio is missing, say so in the audio factor and lower confidence; do not invent speech.
- Never mention that you only saw sampled frames; talk about the reel naturally.`;
}

export async function callGemini({ frames, audio, meta }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("GEMINI_API_KEY is not set"), { status: 500 });
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const parts = [{ text: buildPrompt(meta) }, { text: "VIDEO FRAMES (timestamp before each frame):" }];
  for (const f of frames) {
    parts.push({ text: `Frame at ${Number(f.t).toFixed(1)}s:` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: f.data } });
  }
  if (audio) {
    parts.push({ text: "AUDIO TRACK:" });
    parts.push({ inlineData: { mimeType: "audio/wav", data: audio } });
  }
  parts.push({ text: "Now produce the JSON report." });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: REPORT_SCHEMA,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (r.status === 429) throw Object.assign(new Error("The free AI quota for today is used up. Please try again later."), { status: 429 });
  if (!r.ok) {
    const text = await r.text();
    throw Object.assign(new Error(`AI request failed (${r.status}): ${text.slice(0, 300)}`), { status: 502 });
  }
  const data = await r.json();
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || "empty response";
    throw Object.assign(new Error(`AI returned no report (${reason}).`), { status: 502 });
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("AI returned an unreadable report. Please try again."), { status: 502 });
  }
  return { report, model };
}

// Deterministic overall score from the factor scores, so the headline number is consistent.
export function normalizeReport(report) {
  const byKey = new Map();
  for (const f of report.factors || []) byKey.set(f.key, f);
  const factors = FACTORS.map((def) => {
    const f = byKey.get(def.key) || {};
    return {
      key: def.key,
      label: def.label,
      weight: def.weight,
      score: Math.round(clamp(f.score, 0, 100)),
      verdict: String(f.verdict || ""),
      detail: String(f.detail || ""),
    };
  });
  const overall = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0));
  const predicted_level = LEVELS.includes(report.predicted_level) ? report.predicted_level : levelFromScore(overall);
  return {
    ...report,
    factors,
    overall_score: overall,
    predicted_level,
    confidence: ["low", "medium", "high"].includes(report.confidence) ? report.confidence : "medium",
    top_fixes: (report.top_fixes || []).slice(0, 3),
    hook_rewrites: (report.hook_rewrites || []).slice(0, 3),
    timeline_notes: (report.timeline_notes || []).slice(0, 8).sort((a, b) => a.at_seconds - b.at_seconds),
    hashtags: (report.hashtags || []).slice(0, 10),
  };
}

export function levelFromScore(s) {
  if (s >= 82) return "breakout";
  if (s >= 65) return "above_usual";
  if (s >= 45) return "around_usual";
  return "below_usual";
}
