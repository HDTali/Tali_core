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
  status text not null default 'active',
  questions_used int not null default 0,
  questions_limit int not null default 3,
  subscription_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

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
