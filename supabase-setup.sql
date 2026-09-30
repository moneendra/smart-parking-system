-- ============================================================
--  Smart Parking System — Supabase setup
--  Run this ONCE: Supabase Dashboard → SQL Editor → New query → paste → Run
--  (Works on the free tier.)
-- ============================================================

create table if not exists public.users (
  id            uuid primary key,
  username      text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.reservations (
  id         uuid primary key,
  slot_id    text not null,
  username   text not null,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz not null,
  status     text not null default 'active',   -- active | released | expired
  created_at timestamptz not null default now()
);

create index if not exists reservations_slot_status_idx
  on public.reservations (slot_id, status);

create index if not exists reservations_username_idx
  on public.reservations (username, status);

-- Row Level Security stays ON with no public policies: the server connects
-- with the secret service_role key (which bypasses RLS), so nothing is
-- readable or writable by anonymous clients.
alter table public.users        enable row level security;
alter table public.reservations enable row level security;
