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
