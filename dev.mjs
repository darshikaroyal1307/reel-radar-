// Local dev server: serves the static files and runs the /api functions like Vercel does.
// Usage: npm run dev   (reads .env if present). Without GEMINI_API_KEY it returns a sample report so you can test the UI.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
if (existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain", ".json": "application/json" };
const PORT = Number(process.env.PORT || 3000);
const MOCK = !process.env.GEMINI_API_KEY;

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try { return text ? JSON.parse(text) : {}; } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z_-]/gi, "");
      req.query = Object.fromEntries(url.searchParams);
      req.body = req.method === "POST" ? await readJson(req) : undefined;
      if (MOCK && name === "analyze") return mockAnalyze(req, res);
      const mod = await import(`./api/${name}.js?t=${Date.now()}`);
      return mod.default(req, res);
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    if (!extname(file)) file += ".html";
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", MIME[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => {
  console.log(`ReelRadar dev server: http://localhost:${PORT}  ${MOCK ? "(MOCK mode: no GEMINI_API_KEY set, returning a sample report)" : ""}`);
});

async function mockAnalyze(req, res) {
  const { normalizeReport, newId } = await import("./api/_lib.js");
  const b = req.body || {};
  console.log(`mock analyze: ${b.frames?.length || 0} frames, audio ${b.audio ? Math.round(b.audio.length * 0.75 / 1024) + " KB" : "none"}, body ${Math.round(JSON.stringify(b).length / 1024)} KB`);
  await new Promise((r) => setTimeout(r, 1500));
  const report = normalizeReport({
    summary: "Sample report (mock mode). The hook lands late and the middle drags, but the payoff is strong. Fix the first 2 seconds and this could beat your usual numbers.",
    predicted_level: "around_usual", confidence: "medium", hook_starts_at_seconds: 2.4,
    has_text_on_screen: false, has_speech: Boolean(b.audio), has_music: false,
    detected_topic: "sample topic", detected_format: "talking head",
    factors: ["hook", "retention", "clarity", "visual", "audio", "text", "ending", "caption", "shareability"].map((key, i) => ({
      key, score: [42, 55, 70, 64, b.audio ? 60 : 20, 30, 66, 50, 48][i],
      verdict: `Sample verdict for ${key}.`, detail: `Sample detail for ${key}: what was observed at 0:02 and why it matters.`,
    })),
    working_well: ["Clear framing", "Good energy in the voice"],
    top_fixes: [
      { title: "Move the hook to second 0", how: "Start with the line you say at 0:04 and put it as bold text on the first frame.", impact: "high" },
      { title: "Add subtitles", how: "Most viewers watch muted. Add auto-captions in the app.", impact: "high" },
      { title: "Cut 0:08–0:14", how: "The point is repeated; trim it.", impact: "medium" },
    ],
    timeline_notes: [
      { at_seconds: 0, note: "Static frame, no text – risky.", kind: "risk" },
      { at_seconds: 4, note: "Strongest line here – this should be the opener.", kind: "strength" },
      { at_seconds: 12, note: "Add a visual change here to hold attention.", kind: "suggestion" },
    ],
    hook_rewrites: ["Nobody tells you this about ...", "I wasted 2 years doing this wrong.", "Watch till the end – the last one is illegal-level good."],
    caption_rewrite: "Sample caption rewrite with a question to invite comments?",
    hashtags: ["#reels", "#creator", "#sample"],
    best_posting_window: "Weekday evenings 7–9 pm local time when your audience is scrolling after work.",
  });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ id: newId(), saved: false, report }));
}
