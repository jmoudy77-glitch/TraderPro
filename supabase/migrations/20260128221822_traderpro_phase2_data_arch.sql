-- TraderPro Phase 2: Durable Data Architecture
-- Candle persistence + symbol metadata + news + execution events + retention helpers

-- Extensions (safe if already enabled)
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- =========================
-- Core reference tables
-- =========================

create table if not exists public.symbol_classification (
  symbol text primary key,
  exchange text null,
  asset_type text null,             -- equity, etf, crypto, etc.
  sector text null,
  industry text null,
  country text null,
  currency text null,
  updated_at timestamptz not null default now()
);

create index if not exists symbol_classification_sector_idx
  on public.symbol_classification (sector);

create table if not exists public.company_profile (
  symbol text primary key references public.symbol_classification(symbol) on delete cascade,
  name text null,
  description text null,
  website text null,
  employees integer null,
  market_cap numeric null,
  ipo_date date null,
  updated_at timestamptz not null default now()
);

-- =========================
-- Candle tables (durable)
-- =========================
-- Notes:
-- - ts is the candle open time in UTC
-- - store numeric as double precision for charting throughput
-- - we keep owner_user_id for future multi-user without refactor; can be nullable for now if you prefer

create table if not exists public.candles_daily (
  owner_user_id uuid null,
  symbol text not null,
  ts timestamptz not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,
  v double precision null,
  source text null, -- twelvedata, alpaca, polygon, etc.
  created_at timestamptz not null default now(),
  primary key (symbol, ts)
);

create index if not exists candles_daily_symbol_ts_idx
  on public.candles_daily (symbol, ts desc);

create table if not exists public.candles_4h (
  owner_user_id uuid null,
  symbol text not null,
  ts timestamptz not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,
  v double precision null,
  source text null,
  created_at timestamptz not null default now(),
  primary key (symbol, ts)
);

create index if not exists candles_4h_symbol_ts_idx
  on public.candles_4h (symbol, ts desc);

create table if not exists public.candles_1h (
  owner_user_id uuid null,
  symbol text not null,
  ts timestamptz not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,
  v double precision null,
  source text null,
  created_at timestamptz not null default now(),
  primary key (symbol, ts)
);

create index if not exists candles_1h_symbol_ts_idx
  on public.candles_1h (symbol, ts desc);

-- =========================
-- Company news (durable)
-- =========================

create table if not exists public.company_news (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  provider text null,               -- e.g. alpaca, benzinga, etc.
  provider_id text null,            -- provider's unique article id if available
  headline text not null,
  summary text null,
  url text null,
  source text null,
  published_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Dedupe key if provider_id exists
create unique index if not exists company_news_provider_dedupe_idx
  on public.company_news (provider, provider_id)
  where provider_id is not null;

create index if not exists company_news_symbol_published_idx
  on public.company_news (symbol, published_at desc);

-- =========================
-- Execution events (durable)
-- =========================
-- This is your audit log for strategy → action → fills.
-- Keep it append-only.

create table if not exists public.execution_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid null,
  account_id text null,             -- broker account id (alpaca)
  symbol text null,
  event_type text not null,         -- intent|order_submitted|fill|cancel|error|note
  ts timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index if not exists execution_events_owner_ts_idx
  on public.execution_events (owner_user_id, ts desc);

create index if not exists execution_events_symbol_ts_idx
  on public.execution_events (symbol, ts desc);

-- =========================
-- Retention helpers (Phase 2)
-- =========================
-- We wire actual scheduling in Phase 4/5 depending on your preference (pg_cron vs external).
-- These functions are safe to call from a scheduled job.

create or replace function public.trim_candles_1h(retain_days integer)
returns bigint
language plpgsql
as $$
declare
  deleted_count bigint;
begin
  delete from public.candles_1h
  where ts < (now() - make_interval(days => retain_days));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.trim_candles_4h(retain_days integer)
returns bigint
language plpgsql
as $$
declare
  deleted_count bigint;
begin
  delete from public.candles_4h
  where ts < (now() - make_interval(days => retain_days));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.trim_company_news(retain_days integer)
returns bigint
language plpgsql
as $$
declare
  deleted_count bigint;
begin
  delete from public.company_news
  where published_at < (now() - make_interval(days => retain_days));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- NOTE:
-- candles_daily retention is intentionally NOT trimmed here (you want ~1Y durable).
-- If later you decide to cap daily candles, add a trim function then.