// GET  /api/feedback?id=<analysis id>  -> { found, analysis summary, feedback }
// POST /api/feedback  { id, views, usual_views, likes, shares, saves, comments, days_since_post, note }
// This is the learning loop: prediction (analyses) + real result (feedback) = one training example.
import { json, clamp, isUuid, supabaseConfigured, sbInsert, sbSelectOne } from "./_lib.js";

export default async function handler(req, res) {
  if (!supabaseConfigured()) return json(res, 503, { error: "Feedback storage is not set up yet." });

  if (req.method === "GET") {
    const id = req.query?.id;
    if (!isUuid(id)) return json(res, 400, { error: "Invalid id" });
    try {
      const a = await sbSelectOne("analyses", { id: `eq.${id}` });
      if (!a) return json(res, 404, { error: "Analysis not found" });
      const fb = await sbSelectOne("feedback", { analysis_id: `eq.${id}`, order: "created_at.desc" });
      return json(res, 200, {
        analysis: {
          id: a.id,
          created_at: a.created_at,
          niche: a.niche,
          overall_score: a.overall_score,
          predicted_level: a.predicted_level,
          usual_views: a.usual_views,
          summary: a.report?.summary || "",
        },
        feedback: fb,
      });
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: "Could not load analysis" });
    }
  }

  if (req.method === "POST") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!isUuid(b.id)) return json(res, 400, { error: "Invalid id" });
    const views = Math.round(clamp(b.views, 0, 1e10));
    if (!(views > 0)) return json(res, 400, { error: "Please enter the view count." });
    const usual = b.usual_views ? Math.round(clamp(b.usual_views, 0, 1e10)) : null;
    const num = (v) => (v === "" || v == null ? null : Math.round(clamp(v, 0, 1e10)));
    try {
      const a = await sbSelectOne("analyses", { id: `eq.${b.id}` });
      if (!a) return json(res, 404, { error: "Analysis not found" });
      const baseline = usual || a.usual_views || null;
      await sbInsert("feedback", {
        analysis_id: b.id,
        views,
        usual_views: baseline,
        likes: num(b.likes),
        comments: num(b.comments),
        shares: num(b.shares),
        saves: num(b.saves),
        days_since_post: num(b.days_since_post),
        performance_ratio: baseline ? Number((views / baseline).toFixed(3)) : null,
        note: typeof b.note === "string" ? b.note.slice(0, 500) : null,
      });
      return json(res, 200, { ok: true, performance_ratio: baseline ? views / baseline : null });
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: "Could not save feedback" });
    }
  }

  return json(res, 405, { error: "Method not allowed" });
}
