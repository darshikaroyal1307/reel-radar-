-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Only extracted features and the report are stored. Videos are never uploaded to the database.

create table if not exists analyses (
  id uuid primary key,
  created_at timestamptz not null default now(),
  ip_hash text,
  model text,
  niche text,
  language text,
  duration_seconds numeric,
  width int,
  height int,
  followers bigint,
  usual_views bigint,
  has_audio boolean,
  will_add_music boolean,
  caption text,
  hashtags text,
  overall_score int,
  predicted_level text,
  confidence text,
  features jsonb,
  report jsonb
);

create index if not exists analyses_ip_created_idx on analyses (ip_hash, created_at desc);
create index if not exists analyses_created_idx on analyses (created_at desc);

create table if not exists feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  analysis_id uuid not null references analyses(id) on delete cascade,
  views bigint not null,
  usual_views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  days_since_post int,
  performance_ratio numeric,
  note text
);

create index if not exists feedback_analysis_idx on feedback (analysis_id);

-- Lock the tables down: the app talks to them with the service key only.
alter table analyses enable row level security;
alter table feedback enable row level security;

-- Training data view: one row per reel with a real result.
-- actual_level uses the same buckets the app predicts, so you can measure accuracy.
create or replace view training_examples as
select
  a.id,
  a.created_at,
  a.niche,
  a.language,
  a.duration_seconds,
  a.followers,
  a.has_audio,
  a.overall_score,
  a.predicted_level,
  a.confidence,
  a.features,
  f.views,
  f.usual_views,
  f.performance_ratio,
  case
    when f.performance_ratio is null then null
    when f.performance_ratio < 0.7 then 'below_usual'
    when f.performance_ratio < 1.5 then 'around_usual'
    when f.performance_ratio < 4 then 'above_usual'
    else 'breakout'
  end as actual_level
from analyses a
join lateral (
  select * from feedback f where f.analysis_id = a.id order by f.created_at desc limit 1
) f on true;

-- Quick accuracy check (run this any time):
-- select
--   count(*) as examples,
--   round(100.0 * avg((predicted_level = actual_level)::int), 1) as exact_match_pct,
--   round(100.0 * avg((
--     (predicted_level in ('above_usual','breakout')) = (actual_level in ('above_usual','breakout'))
--   )::int), 1) as direction_match_pct
-- from training_examples where actual_level is not null;
