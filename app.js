/* ReelRadar client: extracts frames + audio in the browser, calls /api/analyze, renders the report. */
(function () {
  "use strict";

  const MAX_SECONDS = 180;
  const MAX_BYTES = 150 * 1024 * 1024;
  const AUDIO_MAX_SECONDS = 120;
  const AUDIO_BUDGET_BYTES = 2_200_000; // keeps the request under Vercel's 4.5 MB body limit after base64
  const FRAME_MAX_SIDE = 512;
  const HOOK_TIMES = [0.1, 0.6, 1.2, 1.8, 2.5, 3.2];
  const BODY_FRAMES = 10;

  const $ = (id) => document.getElementById(id);
  const fileInput = $("file"), drop = $("drop"), analyzeBtn = $("analyze"), consent = $("consent");
  const formCard = $("form-card"), progressCard = $("progress-card"), reportEl = $("report");
  const formError = $("form-error");
  let file = null;

  // ---------- file picking ----------
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setFile(f); });
  consent.addEventListener("change", updateButton);

  function setFile(f) {
    hideError();
    if (!f) return;
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v)$/i.test(f.name)) return showError("Please choose a video file (MP4 or MOV).");
    if (f.size > MAX_BYTES) return showError("That file is over 150 MB. Export a smaller version and try again.");
    file = f;
    $("file-name").textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB`;
    $("file-chip").classList.remove("hidden");
    updateButton();
  }
  function updateButton() { analyzeBtn.disabled = !(file && consent.checked); }
  function showError(msg) { formError.textContent = msg; formError.classList.remove("hidden"); }
  function hideError() { formError.classList.add("hidden"); }

  // ---------- progress ----------
  function step(name, state) {
    const li = document.querySelector(`#steps li[data-step="${name}"]`);
    if (!li) return;
    li.classList.remove("active", "done");
    if (state) li.classList.add(state);
  }
  function resetSteps() { document.querySelectorAll("#steps li").forEach((li) => li.classList.remove("active", "done")); $("frames-preview").innerHTML = ""; }

  // ---------- analyze ----------
  analyzeBtn.addEventListener("click", async () => {
    if (!file) return;
    hideError();
    analyzeBtn.disabled = true;
    formCard.classList.add("hidden");
    reportEl.classList.add("hidden");
    progressCard.classList.remove("hidden");
    resetSteps();
    window.scrollTo({ top: progressCard.offsetTop - 12, behavior: "smooth" });

    try {
      step("read", "active");
      const video = await loadVideo(file);
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Could not read the video length. Try exporting it as MP4.");
      if (video.duration > MAX_SECONDS) throw new Error(`This video is ${Math.round(video.duration)}s long. Reels up to 3 minutes are supported.`);
      step("read", "done");

      step("frames", "active");
      const frames = await extractFrames(video);
      step("frames", "done");

      step("audio", "active");
      const audio = await extractAudio(file, video.duration).catch((e) => { console.warn("audio extraction failed", e); return null; });
      step("audio", "done");

      const meta = {
        niche: $("niche").value,
        language: $("language").value,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        followers: num($("followers").value),
        usual_views: num($("usual_views").value),
        will_add_music: $("will_add_music").checked,
        caption: $("caption").value.trim(),
        hashtags: $("hashtags").value.trim(),
        audio_seconds: audio ? audio.seconds : 0,
        audio_rms: audio ? audio.rms : 0,
      };
      URL.revokeObjectURL(video.src);

      step("ai", "active");
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frames, audio: audio ? audio.base64 : null, meta }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Analysis failed (${res.status})`);
      step("ai", "done");

      const entry = { id: data.id, saved: data.saved, date: Date.now(), niche: meta.niche, score: data.report.overall_score, level: data.report.predicted_level, report: data.report, duration: meta.duration };
      saveHistory(entry);
      renderReport(entry);
      progressCard.classList.add("hidden");
      formCard.classList.remove("hidden");
      reportEl.classList.remove("hidden");
      window.scrollTo({ top: reportEl.offsetTop - 12, behavior: "smooth" });
    } catch (e) {
      console.error(e);
      progressCard.classList.add("hidden");
      formCard.classList.remove("hidden");
      showError(e.message || "Something went wrong. Please try again.");
      window.scrollTo({ top: formError.offsetTop - 80, behavior: "smooth" });
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  function num(v) { const n = Number(String(v).replace(/[^\d.]/g, "")); return n > 0 ? n : null; }

  // ---------- video helpers ----------
  function loadVideo(f) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      v.src = URL.createObjectURL(f);
      const to = setTimeout(() => reject(new Error("The video took too long to load.")), 30000);
      v.addEventListener("loadeddata", () => { clearTimeout(to); resolve(v); }, { once: true });
      v.addEventListener("error", () => { clearTimeout(to); reject(new Error("This video format can't be played in your browser. Try MP4 (H.264).")); }, { once: true });
      v.load();
    });
  }

  function seek(v, t) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("Seeking the video timed out.")), 8000);
      v.addEventListener("seeked", () => { clearTimeout(to); resolve(); }, { once: true });
      v.currentTime = Math.min(Math.max(t, 0), Math.max(0, v.duration - 0.05));
    });
  }

  async function extractFrames(v) {
    const d = v.duration;
    const times = HOOK_TIMES.filter((t) => t < d);
    const start = 4, end = Math.max(start, d - 0.3);
    if (d > start) for (let i = 0; i < BODY_FRAMES; i++) times.push(start + ((end - start) * i) / Math.max(1, BODY_FRAMES - 1));
    const uniq = [...new Set(times.map((t) => Number(t.toFixed(2))))].sort((a, b) => a - b);

    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    const preview = $("frames-preview");
    const frames = [];
    for (const t of uniq) {
      await seek(v, t);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      frames.push({ t, data: dataUrl.split(",")[1] });
      if (frames.length <= 8) { const img = new Image(); img.src = dataUrl; preview.appendChild(img); }
    }
    return frames;
  }

  async function extractAudio(f, duration) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const buf = await f.arrayBuffer();
    const ctx = new AC();
    let decoded;
    try {
      decoded = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    } finally { ctx.close && ctx.close(); }
    const seconds = Math.min(decoded.duration, AUDIO_MAX_SECONDS, duration || decoded.duration);
    const rate = Math.max(8000, Math.min(16000, Math.floor(AUDIO_BUDGET_BYTES / (2 * seconds))));
    const off = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length / 4));
    if (rms < 0.0005) return null; // effectively silent
    return { base64: wavBase64(pcm, rate), seconds, rms: Number(rms.toFixed(4)) };
  }

  function wavBase64(pcm, rate) {
    const n = pcm.length, bytes = new ArrayBuffer(44 + n * 2), dv = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    const u8 = new Uint8Array(bytes);
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ---------- report rendering ----------
  const LEVEL_TEXT = {
    below_usual: "Likely below your usual",
    around_usual: "Likely around your usual",
    above_usual: "Likely above your usual",
    breakout: "Breakout potential",
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cls = (s) => (s >= 65 ? "good" : s >= 45 ? "ok" : "bad");
  const fmtT = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  function renderReport(entry) {
    const r = entry.report;
    const ringColor = `var(--${cls(r.overall_score)})`;
    const fbLink = `feedback.html?id=${encodeURIComponent(entry.id)}`;
    reportEl.innerHTML = `
      <div class="card">
        <div class="score-hero">
          <div class="ring" style="--p:${r.overall_score};--ring-color:${ringColor}"><b>${r.overall_score}</b><small>/ 100</small></div>
          <div>
            <span class="level ${esc(r.predicted_level)}">${esc(LEVEL_TEXT[r.predicted_level] || r.predicted_level)}</span>
            <span class="small"> · confidence: ${esc(r.confidence)}</span>
            <p class="summary">${esc(r.summary)}</p>
            <div class="meta-chips">
              <span class="chip">${esc(r.detected_format)}</span>
              <span class="chip">${esc(r.detected_topic)}</span>
              <span class="chip">${fmtT(entry.duration)} long</span>
              <span class="chip">hook at ${Number(r.hook_starts_at_seconds).toFixed(1)}s</span>
              <span class="chip">${r.has_text_on_screen ? "text on screen ✓" : "no text on screen"}</span>
              <span class="chip">${r.has_speech ? "speech ✓" : "no speech"}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Top 3 fixes</h2>
        ${r.top_fixes.map((f, i) => `
          <div class="fix"><div class="n">${i + 1}</div><div><b>${esc(f.title)}<span class="impact ${esc(f.impact)}">${esc(f.impact)} impact</span></b><div class="how">${esc(f.how)}</div></div></div>`).join("")}
      </div>

      <div class="card">
        <h2>Score breakdown</h2>
        <p class="small">Tap a factor to see the details.</p>
        ${r.factors.map((f) => `
          <div class="factor">
            <div class="factor-head" onclick="this.parentElement.classList.toggle('open')">
              <span class="name">${esc(f.label)}</span><span class="num s-${cls(f.score)}">${f.score}</span>
            </div>
            <div class="bar"><i class="bg-${cls(f.score)}" style="width:${f.score}%"></i></div>
            <div class="verdict">${esc(f.verdict)}</div>
            <div class="detail">${esc(f.detail)}</div>
          </div>`).join("")}
      </div>

      <div class="card">
        <h2>Moment by moment</h2>
        <ul class="timeline">${r.timeline_notes.map((n) => `<li class="${esc(n.kind)}"><span class="t">${fmtT(n.at_seconds)}</span><span>${esc(n.note)}</span></li>`).join("")}</ul>
      </div>

      <div class="card">
        <h2>Hook rewrites</h2>
        <p class="small">Try one of these as your opening line or first on-screen text.</p>
        ${r.hook_rewrites.map((h) => `<div class="quote">${esc(h)}</div>`).join("")}
        <h3>Caption</h3>
        <div class="quote">${esc(r.caption_rewrite)}</div>
        <h3>Hashtags</h3>
        <div class="tags">${r.hashtags.map((h) => `<span>${esc(h.startsWith("#") ? h : "#" + h)}</span>`).join("")}</div>
        <h3>When to post</h3>
        <p class="small" style="color:var(--text)">${esc(r.best_posting_window)}</p>
        ${r.working_well.length ? `<h3>What's already working</h3><ul class="plain">${r.working_well.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      </div>

      <div class="card">
        <h2>After you post: tell us how it did</h2>
        <p class="small">This is how ReelRadar learns. Come back in 2–7 days and enter the real views. ${entry.saved ? "" : "<b>(Result saving is not set up on this deployment yet.)</b>"}</p>
        <div class="actions">
          <a class="btn btn-secondary" href="${fbLink}">Open results form</a>
          <button class="btn btn-secondary" id="copy-link">Copy results link</button>
          <button class="btn btn-secondary" id="copy-report">Copy report as text</button>
        </div>
        <p class="small">Analysis ID: <code>${esc(entry.id)}</code></p>
      </div>`;

    $("copy-link").addEventListener("click", () => copy(new URL(fbLink, location.href).href, "copy-link"));
    $("copy-report").addEventListener("click", () => copy(reportText(entry), "copy-report"));
  }

  function copy(text, btnId) {
    navigator.clipboard?.writeText(text).then(() => { const b = $(btnId); const old = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = old), 1500); });
  }

  function reportText(entry) {
    const r = entry.report;
    return [
      `ReelRadar report – score ${r.overall_score}/100 – ${LEVEL_TEXT[r.predicted_level]}`,
      r.summary, "",
      "TOP FIXES:", ...r.top_fixes.map((f, i) => `${i + 1}. ${f.title} – ${f.how}`), "",
      "SCORES:", ...r.factors.map((f) => `- ${f.label}: ${f.score} – ${f.verdict}`), "",
      "HOOK IDEAS:", ...r.hook_rewrites.map((h) => `- ${h}`), "",
      "CAPTION:", r.caption_rewrite, r.hashtags.join(" "),
    ].join("\n");
  }

  // ---------- local history ----------
  const KEY = "reelradar.history";
  function loadHistory() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } }
  function saveHistory(entry) {
    try {
      const list = loadHistory().filter((e) => e.id !== entry.id);
      list.unshift(entry);
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
    } catch { /* private mode etc. */ }
    renderHistory();
  }
  function renderHistory() {
    const list = loadHistory();
    const ul = $("history");
    if (!list.length) { ul.innerHTML = `<li class="small">No reels analyzed on this device yet.</li>`; return; }
    ul.innerHTML = list.map((e) => `
      <li>
        <span class="num s-${cls(e.score)}"><b>${e.score}</b></span>
        <div class="grow"><div>${esc(LEVEL_TEXT[e.level] || e.level)} · ${esc(e.niche)}</div><div class="date">${new Date(e.date).toLocaleString()}</div></div>
        <button class="btn btn-secondary" data-view="${esc(e.id)}">View</button>
        <a class="btn btn-secondary" href="feedback.html?id=${encodeURIComponent(e.id)}">Results</a>
      </li>`).join("");
    ul.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
      const e = loadHistory().find((x) => x.id === b.dataset.view);
      if (!e) return;
      renderReport(e);
      reportEl.classList.remove("hidden");
      window.scrollTo({ top: reportEl.offsetTop - 12, behavior: "smooth" });
    }));
  }
  renderHistory();
})();
