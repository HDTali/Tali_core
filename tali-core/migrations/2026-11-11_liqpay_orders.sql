-- ============================================================
-- Website: paid readings through LiqPay (11.11.2026).
-- ONLY ADDS one new table. No existing table, column or row is changed.
-- Safe to run twice ("if not exists").
-- ============================================================

-- orders — every order from the site's order form and what happened to its payment.
--   created  -> the person filled the form and was sent to LiqPay
--   paid     -> LiqPay confirmed the payment (signature checked)
--   failed   -> payment declined or error
--   refunded -> money returned
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null unique,          -- what the client sees, e.g. NP-20261111-7K3Q
  lang text not null check (lang in ('en', 'uk', 'ru')),  -- site version the order came from
  topic text not null,                     -- work, energy, self, relationships, couple, child, family, mentoring
  format text not null,                    -- pdf, audio, video, mentoring
  amount numeric(10, 2) not null,          -- what is charged
  currency text not null check (currency in ('UAH', 'USD')),
  status text not null default 'created' check (status in ('created', 'paid', 'failed', 'refunded')),
  client_name text not null,
  email text not null,                     -- lowercased
  reading_lang text not null,              -- language of the reading
  details jsonb not null default '{}',     -- birth details of each person, situation, questions, note
  consent_text text not null,              -- the checkbox text exactly as shown
  policy_version text not null,            -- version of the Terms / Privacy Policy
  liqpay_payment_id text,                  -- LiqPay's id of the payment
  liqpay_status text,                      -- LiqPay's own status word (success, failure, ...)
  liqpay_data jsonb,                       -- the last confirmed message from LiqPay, for checks
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  emails_sent_at timestamptz               -- when the confirmation letters went out
);
create index if not exists orders_status_idx on orders (status, created_at);
create index if not exists orders_email_idx on orders (email, created_at);
