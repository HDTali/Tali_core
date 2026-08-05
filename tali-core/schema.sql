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
