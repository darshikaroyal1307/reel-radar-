# ReelRadar

Upload a reel before posting it → get a hook score, pacing check, caption fixes and a prediction of how it will perform compared to your usual reels. Free to run: Vercel (hosting) + Google Gemini (AI, free tier) + Supabase (database, free tier).

## How it works

1. The browser extracts ~16 frames (dense in the first 3 seconds) and a compressed audio track. The full video never leaves the device.
2. `api/analyze.js` sends them to Gemini with a detailed strategist prompt and gets a structured JSON report.
3. The report and extracted features are saved to Supabase (never the video).
4. Days later the creator reports real views on `feedback.html` → prediction + real result = one training example (`training_examples` view).

## Files

```
index.html / app.js / style.css   the app
feedback.html                     "report your real views" page (the learning loop)
privacy.html                      privacy page (edit the contact line)
api/analyze.js                    POST: analyze a reel
api/feedback.js                   GET/POST: load analysis, save real results
api/_lib.js                       Gemini prompt + schema, Supabase REST helpers, scoring
supabase/schema.sql               database tables + training_examples view
dev.mjs                           local dev server (npm run dev)
```

## Deploy for free (about 20 minutes)

### 1. Gemini API key
1. Go to https://aistudio.google.com/apikey and sign in with Google.
2. Create API key → copy it. Keep it secret.

### 2. Supabase (database)
1. https://supabase.com → New project (free). Pick any region, save the DB password somewhere.
2. Left menu → **SQL Editor** → New query → paste the whole of `supabase/schema.sql` → **Run**.
3. Left menu → **Project Settings → API**: copy the **Project URL** and the **service_role** key (under "Project API keys", click reveal).

### 3. Put the code on GitHub
1. Create a free account at https://github.com, then a new **empty** repository named `reelradar`.
2. In this folder, run:

```bash
git init
git add .
git commit -m "ReelRadar v0.1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/reelradar.git
git push -u origin main
```

### 4. Vercel
1. https://vercel.com → Sign up with GitHub (free Hobby plan).
2. **Add New → Project** → import `reelradar`. Framework preset: **Other**. Leave build settings empty.
3. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | your Gemini key |
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_SERVICE_KEY` | your service_role key |
| `DAILY_LIMIT_PER_IP` | `3` |
| `RATE_SALT` | any random text |

4. Click **Deploy**. You get a link like `https://reelradar-xxxx.vercel.app`.

Every later `git push` redeploys automatically.

### 5. Test it
Open the link, upload a reel, wait ~30 s. Then in Supabase → **Table Editor → analyses** you should see one row.

## Local testing

```bash
npm run dev
```

Open http://localhost:3000. Without a `.env` file it runs in **mock mode** (returns a sample report, so you can test uploads without using your quota). Copy `.env.example` to `.env` and fill it in for the real thing.

## Watching it learn

In Supabase → SQL Editor:

```sql
select * from training_examples order by created_at desc;
```

Accuracy so far:

```sql
select count(*) as examples,
  round(100.0 * avg((predicted_level = actual_level)::int), 1) as exact_match_pct,
  round(100.0 * avg(((predicted_level in ('above_usual','breakout')) = (actual_level in ('above_usual','breakout')))::int), 1) as direction_match_pct
from training_examples where actual_level is not null;
```

Roadmap for the model:
- **0–100 examples**: read where predictions were wrong, improve the prompt in `api/_lib.js` (`buildPrompt`).
- **100–1,000**: find patterns per niche in `training_examples` and add them to the prompt as rules.
- **1,000+**: train a small model (XGBoost) on `features` → `actual_level`, and blend it with the Gemini score.

## Limits of the free tiers

- Gemini free tier: a limited number of requests per day and per minute. When it's exhausted users see "free AI quota used up".
- Vercel Hobby: request body max 4.5 MB (the app stays under it), function time limit set to 60 s.
- Supabase free: 500 MB database. Each analysis is ~5–10 KB, so that's tens of thousands of reels.
- On the Gemini free tier Google may use submitted content to improve their models. The consent checkbox and privacy page disclose this. Remember to put your contact email in `privacy.html`.

## Growing

- SEO: add a custom domain in Vercel (Settings → Domains), submit the site in Google Search Console, and write short guides (e.g. "best hook for fitness reels") as extra pages.
- First users: post reels about the tool on Instagram, share in creator communities.
- Monetize later: keep 3 free analyses/day, add a paid plan and move to a paid Gemini tier.
