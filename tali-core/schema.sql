-- Tali Core: Identity & Profile + Billing & Entitlements
-- First slice of the target architecture (Этап 7 аудита).

create extension if not exists "pgcrypto";

-- Internal user_id — the thing telegram_id was never allowed to be:
-- a stable identity that Telegram, Web, iOS, Android can all point at.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists identity_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('telegram', 'email', 'apple')),
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (provider, external_id)
);

-- Replaces the subscription/limit fields scattered inside the Users God-table.
create table if not exists entitlements (
  user_id uuid primary key references users(id) on delete cascade,
  plan text not null default 'free',
  -- 'free' | 'active' | 'expired' — matches n8n's subscription_status
  -- exactly (see "bc_free"/"bc_active"/"bc_expired" filters in the real
  -- workflow), so the paywall gate can compare against the same three
  -- values it already uses.
  status text not null default 'free',
  questions_used int not null default 0,
  questions_limit int not null default 5,
  subscription_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Monthly cap for active subscribers (150/month, reset on the 1st — same cron
-- job n8n already runs today against Airtable, just pointed at this table
-- once Conversation Service is live). Separate from questions_used/questions_limit
-- above, which is the free tier's one-time lifetime allowance and never resets.
alter table entitlements add column if not exists monthly_used int not null default 0;
alter table entitlements add column if not exists monthly_limit int not null default 150;

-- questions_limit default bumped 3 -> 5. The "create table if not exists"
-- above only applies to a brand-new database — since entitlements already
-- exists in yours, that line is silently skipped and the old default (3)
-- would stick around without this explicit alter.
alter table entitlements alter column questions_limit set default 5;

-- monthly_limit corrected 150 -> 120, matching the real number confirmed
-- 04.08.2026 (this file previously had the wrong figure). Same reasoning as
-- above: explicit alter needed so it actually takes effect on your database.
alter table entitlements alter column monthly_limit set default 120;

-- status default was wrongly 'active' — every brand-new, never-paid user
-- (see identityCore.js's resolveIdentity) got an entitlements row that
-- LOOKED like a paying active subscriber, which would have made the paywall
-- gate below let everyone through unlimited. Found 05.08.2026 while building
-- the paywall. Fixes both the default AND any test rows already wrongly
-- marked 'active' that never actually paid (no subscription_expires_at set
-- — a real payer always has one, from the WayForPay callback handler).
alter table entitlements alter column status set default 'free';
update entitlements set status = 'free' where status = 'active' and subscription_expires_at is null;

-- Single payments ledger, replacing WayForPay logic duplicated in three places.
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  order_reference text not null unique,
  amount numeric,
  currency text,
  status text,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

-- Second slice: Conversation & Profile (Этап 7 аудита).
-- Everything below replaces the rest of the Users God-table fields that
-- Identity & Billing didn't already claim — onboarding state, birth data,
-- computed chart, memory, language, and free-chat message history.

create table if not exists profiles (
  user_id uuid primary key references users(id) on delete cascade,
  -- onboarding state machine: new / waiting_name / waiting_gender /
  -- waiting_date / waiting_time / waiting_location / ready
  state text not null default 'new',
  display_name text,
  full_name text,
  gender text,
  birth_date text,
  birth_time text,
  birth_location text,
  lang text not null default 'ru',
  chart_data jsonb,      -- thd.data.chart only (small subset, used for the onboarding summary text)
  chart_compact jsonb,   -- compact "passport" fed into the Claude system prompt
  memory_summary text,   -- Haiku-compressed memory, updated after each free-chat turn
  last_topic text,
  last_topic_label text,
  updated_at timestamptz not null default now()
);

-- Full raw THD API response — matches n8n's separate `chart_data_full`
-- Airtable field (distinct from the small `chart_data`/`chart` subset).
-- Added 05.08.2026 after finding the real "паспорт карты" node
-- (Code JavaScript7) rebuilds chart_compact FROM chart_data_full, not from
-- chart_data — without storing the full response, chart_compact could never
-- be rebuilt later (bug fix, schema change) without a paid THD API recalc.
alter table profiles add column if not exists chart_data_full jsonb;

-- Free-chat message history — the context window sent to Claude on each turn.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_user_id_created_at_idx on messages (user_id, created_at);

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

-- ============================================================
-- Website, stage 5 (09.11.2026): PDF reading by email, Tali waitlist, consents.
-- ONLY ADDS three new tables. No existing table, column or row is changed.
-- Safe to run twice ("if not exists").
-- ============================================================

-- 1. consents — who agreed to what, when, and the exact wording they saw.
--    GDPR asks us to be able to prove consent. One row per tick of a checkbox.
create table if not exists consents (
  id uuid primary key default gen_random_uuid(),
  email text not null,                    -- lowercased
  purpose text not null check (purpose in ('reading_pdf', 'tali_waitlist', 'news')),
  policy_version text not null,           -- e.g. '2026-11-09', version of the Privacy Policy
  consent_text text not null,             -- the checkbox text exactly as shown on the site
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz                -- filled when the person unsubscribes / asks to delete
);
create index if not exists consents_email_idx on consents (email);

-- 2. waitlist — people who want to hear when Tali speaks English.
create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,             -- lowercased, one row per person
  lang text not null default 'en',
  source text not null default 'site',
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

-- 3. reading_requests — every "send me my PDF" order and what happened to it,
--    so no letter is ever lost silently (queued -> processing -> sent / failed).
create table if not exists reading_requests (
  id uuid primary key default gen_random_uuid(),
  web_chart_id uuid not null references web_charts(id),  -- the chart calculated on the site
  user_id uuid references users(id) on delete set null,   -- same users table as the Telegram bot (provider 'email')
  email text not null,                    -- lowercased
  display_name text,                      -- optional first name for the greeting
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  email_message_id text,                  -- id returned by the email service
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists reading_requests_status_idx on reading_requests (status, created_at);
create index if not exists reading_requests_email_idx on reading_requests (email, created_at);
