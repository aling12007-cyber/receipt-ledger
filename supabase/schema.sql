-- Receipt Ledger — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

-- 1) Journal entries (one row per receipt / income record)
create table if not exists public.entries (
  id            text primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type          text not null check (type in ('expense','income')),
  date          date not null,
  vendor        text default '',
  invoice_no    text default '',          -- 適格請求書発行事業者登録番号 (T + 13 digits)
  items         text default '',
  amt10         integer not null default 0, -- 10% items, tax included
  amt8          integer not null default 0, -- 8% reduced-rate items, tax included
  amt0          integer not null default 0, -- not subject to consumption tax
  debit         text not null,
  credit        text not null,
  biz_ratio     integer not null default 100 check (biz_ratio between 0 and 100),
  memo          text default '',
  receipt_path  text,                     -- path in the "receipts" storage bucket
  ai_confidence text default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists entries_user_date on public.entries (user_id, date desc);

-- 2) Per-user settings
create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3) Change history (電子帳簿保存法: 訂正・削除の履歴). Written by trigger; users can read but never change it.
create table if not exists public.entry_history (
  history_id bigint generated always as identity primary key,
  entry_id   text not null,
  user_id    uuid not null,
  action     text not null check (action in ('update','delete')),
  old_row    jsonb not null,
  changed_at timestamptz not null default now()
);
create index if not exists entry_history_user on public.entry_history (user_id, changed_at desc);

create or replace function public.log_entry_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.entry_history (entry_id, user_id, action, old_row)
  values (old.id, old.user_id, lower(tg_op), to_jsonb(old));
  return coalesce(new, old);
end $$;

drop trigger if exists entries_history on public.entries;
create trigger entries_history after update or delete on public.entries
for each row execute function public.log_entry_change();

-- 4) Row-level security: each user sees only their own rows
alter table public.entries enable row level security;
alter table public.settings enable row level security;
alter table public.entry_history enable row level security;

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "read own history" on public.entry_history;
create policy "read own history" on public.entry_history for select
  using (user_id = auth.uid());

-- 5) Private storage bucket for receipt images: <user id>/<YYYY-MM>/<file>.jpg
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts read own" on storage.objects;
create policy "receipts read own" on storage.objects for select
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "receipts upload own" on storage.objects;
create policy "receipts upload own" on storage.objects for insert
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
-- No update/delete policy on purpose: receipt images can't be altered or removed from the app.
