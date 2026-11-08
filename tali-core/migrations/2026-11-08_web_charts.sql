
-- ============================================================
-- Website (English site, 08.11.2026): charts calculated on the site.
-- ONLY ADDS a new table — no existing table or row is changed.
--
-- Why it exists:
--  1. Cache: the same birth data is never sent to THD twice
--     (saves THD limits when people refresh the page).
--  2. Daily safety fuse: the site counts rows created today and stops
--     calling THD above a limit, so nobody can burn the THD quota.
--  3. chart_id: the "send me the PDF" step (stage 5) refers to this row
--     instead of recalculating.
-- No email or name here — the row is anonymous. Rows that never got a
-- PDF order are deleted after 30 days (GDPR: don't keep what isn't needed).
-- ============================================================
create table if not exists web_charts (
  id uuid primary key default gen_random_uuid(),
  input_hash text not null unique,        -- fingerprint of date|time|place, the cache key
  birth_date text not null,               -- YYYY-MM-DD
  birth_time text not null,               -- HH:MM, 24h, local time of birth
  birth_location text not null,           -- as the person typed it
  thd_data jsonb not null,                -- full THD API response (same as profiles.chart_data_full)
  hits int not null default 1,            -- how many times this exact chart was requested
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists web_charts_created_at_idx on web_charts (created_at);
