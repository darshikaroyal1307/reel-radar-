// POST /api/analyze
// Body (JSON): { frames: [{t, data(base64 jpeg)}], audio: base64 wav | null, meta: {...} }
// The browser extracts frames + audio locally, so the full video never leaves the user's device.
import {
  json, clamp, newId, clientIp, hashIp, callGemini, normalizeReport,
  supabaseConfigured, sbInsert, sbCount,
} from "./_lib.js";

const NICHES = new Set([
  "general", "fitness", "food", "comedy", "education", "finance", "tech", "beauty", "fashion",
  "travel", "motivation", "business", "music", "dance", "gaming", "lifestyle", "parenting", "art",
]);
const LANGS = new Set(["en", "hinglish", "hi"]);
const MAX_FRAMES = 20;
const MAX_FRAME_B64 = 400_000;    // ~300KB jpeg
const MAX_AUDIO_B64 = 3_400_000;  // ~2.5MB wav
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT_PER_IP || 3);

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) return json(res, 400, { error: "Invalid request body" });

  // ---- validate input ----
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, MAX_FRAMES) : [];
  if (frames.length < 3) return json(res, 400, { error: "Not enough video frames were extracted. Try a different file." });
  for (const f of frames) {
    if (typeof f.data !== "string" || f.data.length > MAX_FRAME_B64 || !/^[A-Za-z0-9+/=]+$/.test(f.data)) {
      return json(res, 400, { error: "Invalid frame data" });
    }
    f.t = clamp(f.t, 0, 600);
  }
  let audio = null;
  if (typeof body.audio === "string" && body.audio.length > 0) {
    if (body.audio.length > MAX_AUDIO_B64 || !/^[A-Za-z0-9+/=]+$/.test(body.audio)) {
      return json(res, 400, { error: "Audio data too large" });
    }
    audio = body.audio;
  }

  const m = body.meta || {};
  const meta = {
    niche: NICHES.has(m.niche) ? m.niche : "general",
    language: LANGS.has(m.language) ? m.language : "en",
    duration: clamp(m.duration, 0.5, 600),
    width: Math.round(clamp(m.width, 16, 8000)),
    height: Math.round(clamp(m.height, 16, 8000)),
    followers: m.followers ? Math.round(clamp(m.followers, 0, 1e9)) : null,
    usual_views: m.usual_views ? Math.round(clamp(m.usual_views, 0, 1e10)) : null,
    will_add_music: Boolean(m.will_add_music),
    caption: typeof m.caption === "string" ? m.caption.slice(0, 2200) : "",
    hashtags: typeof m.hashtags === "string" ? m.hashtags.slice(0, 500) : "",
    has_audio: Boolean(audio),
    audio_seconds: audio ? clamp(m.audio_seconds, 0, 600) : 0,
    audio_rms: audio ? clamp(m.audio_rms, 0, 1) : 0,
  };
  meta.orientation = meta.height > meta.width ? "vertical" : meta.height === meta.width ? "square" : "horizontal";

  // ---- rate limit (only when a database is configured) ----
  const ipHash = hashIp(clientIp(req));
  const db = supabaseConfigured();
  if (db && DAILY_LIMIT > 0) {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const used = await sbCount("analyses", { ip_hash: `eq.${ipHash}`, created_at: `gt.${since}` });
      if (used >= DAILY_LIMIT) {
        return json(res, 429, { error: `Free limit reached: ${DAILY_LIMIT} analyses per day. Come back tomorrow!` });
      }
    } catch (e) {
      console.error("rate-limit check failed:", e.message);
    }
  }

  // ---- analyze ----
  let report, model;
  try {
    const out = await callGemini({ frames, audio, meta });
    report = normalizeReport(out.report);
    model = out.model;
  } catch (e) {
    console.error("analyze failed:", e);
    return json(res, e.status || 500, { error: e.message || "Analysis failed" });
  }

  // ---- persist (features + report only; never the video) ----
  const id = newId();
  if (db) {
    try {
      await sbInsert("analyses", {
        id,
        ip_hash: ipHash,
        model,
        niche: meta.niche,
        language: meta.language,
        duration_seconds: meta.duration,
        width: meta.width,
        height: meta.height,
        followers: meta.followers,
        usual_views: meta.usual_views,
        has_audio: meta.has_audio,
        will_add_music: meta.will_add_music,
        caption: meta.caption || null,
        hashtags: meta.hashtags || null,
        overall_score: report.overall_score,
        predicted_level: report.predicted_level,
        confidence: report.confidence,
        features: {
          hook_starts_at_seconds: report.hook_starts_at_seconds,
          has_text_on_screen: report.has_text_on_screen,
          has_speech: report.has_speech,
          has_music: report.has_music,
          detected_topic: report.detected_topic,
          detected_format: report.detected_format,
          audio_rms: meta.audio_rms,
          factor_scores: Object.fromEntries(report.factors.map((f) => [f.key, f.score])),
        },
        report,
      });
    } catch (e) {
      console.error("save failed:", e.message);
    }
  }

  return json(res, 200, { id, saved: db, report });
}
