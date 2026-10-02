-- Receipt Ledger — accounting core (P1 of the Accounting Core Completion Plan)
-- Run once in Supabase → SQL Editor → New query → paste this whole file → Run. Safe to run again.
-- Adds the double-entry model next to the existing "entries" table; nothing existing is changed or removed.
--
--   documents        原始証憑 (receipt image / PDF). The file itself never changes.
--   transactions     取引: what happened, plus what OCR / AI suggested and its review status
--   journal_entries  仕訳 (header): draft → posted (→ reversed by a new entry, never edited or deleted)
--   journal_lines    仕訳行: account, debit, credit, 税区分, tax amount
--   account_master   standard 勘定科目 (shared, read-only) · accounts: the user's own extra accounts
--   fiscal_years     filing type, consumption tax settings, year lock
--   fixed_assets · allocation_rules (家事按分) · learning_rules (vendor → account) · legacy_map · audit_log
--
-- Rules the database itself enforces (the app checks them too):
--   * a journal entry is created as draft; it can be posted only when debits = credits (≥ 2 lines)
--   * posted and void entries can never be changed; corrections are reversal entries
--   * deleting is permanent and only possible through public.purge_journal (the entry, its reversals,
--     and the transaction / document only it used are removed, with no trace in the audit log)
--   * lines can be added or changed only while their entry is a draft
--   * nothing can be written into a locked year
--   * receipt files (path, hash) can never be changed; documents go only with a purged entry
--   * every other change is written to audit_log, which users can read but not change

-- ---------- tax codes (税区分) ----------
create or replace function public.valid_tax_code(c text) returns boolean language sql immutable as $$
  select c in ('-','P10','P8','PN','PX','S10','S8','SN','SE','SX')
$$;

-- ---------- standard chart of accounts ----------
create table if not exists public.account_master (
  name        text primary key,
  type        text not null check (type in ('asset','liability','equity','revenue','expense')),
  filing_line text,                    -- 青色申告決算書 row name (expenses) or 貸借対照表 line
  default_tax text not null default '-' check (public.valid_tax_code(default_tax)),
  sort        integer not null
);
insert into public.account_master (name, type, filing_line, default_tax, sort) values
  ('現金','asset','現金','-',100), ('普通預金','asset','その他の預金','-',110), ('売掛金','asset','売掛金','-',120),
  ('未収入金','asset','未収入金','-',130), ('棚卸資産','asset','棚卸資産','-',140), ('前払金','asset','前払金','-',150),
  ('仮払金','asset','仮払金','-',160), ('建物附属設備','asset','建物附属設備','P10',170), ('機械装置','asset','機械装置','P10',175),
  ('車両運搬具','asset','車両運搬具','P10',180), ('工具器具備品','asset','工具器具備品','P10',190),
  ('買掛金','liability','買掛金','-',200), ('未払金','liability','未払金','-',210), ('未払費用','liability','未払費用','-',220),
  ('前受金','liability','前受金','-',230), ('借入金','liability','借入金','-',240), ('預り金','liability','預り金','-',250),
  ('元入金','equity','元入金','-',300), ('事業主借','equity','事業主借','-',310), ('事業主貸','equity','事業主貸','-',320),
  ('売上高','revenue','売上（収入）金額','S10',400), ('雑収入','revenue','売上（収入）金額','S10',410),
  ('仕入高','expense','仕入金額','P10',500), ('租税公課','expense','租税公課','PX',510), ('荷造運賃','expense','荷造運賃','P10',520),
  ('水道光熱費','expense','水道光熱費','P10',530), ('旅費交通費','expense','旅費交通費','P10',540), ('通信費','expense','通信費','P10',550),
  ('広告宣伝費','expense','広告宣伝費','P10',560), ('接待交際費','expense','接待交際費','P10',570), ('損害保険料','expense','損害保険料','PN',580),
  ('修繕費','expense','修繕費','P10',590), ('消耗品費','expense','消耗品費','P10',600), ('減価償却費','expense','減価償却費','-',610),
  ('福利厚生費','expense','福利厚生費','P10',620), ('給料賃金','expense','給料賃金','PX',630), ('外注工賃','expense','外注工賃','P10',640),
  ('利子割引料','expense','利子割引料','PN',650), ('地代家賃','expense','地代家賃','P10',660), ('貸倒金','expense','貸倒金','-',670),
  ('会議費','expense',null,'P10',700), ('新聞図書費','expense',null,'P10',710), ('支払手数料','expense',null,'P10',720),
  ('車両費','expense',null,'P10',730), ('研修費','expense',null,'P10',740), ('雑費','expense','雑費','P10',790)
on conflict (name) do update set type = excluded.type, filing_line = excluded.filing_line, default_tax = excluded.default_tax, sort = excluded.sort;

-- user's own accounts (自訂科目)
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null check (type in ('asset','liability','equity','revenue','expense')),
  filing_line text,
  default_tax text not null default '-' check (public.valid_tax_code(default_tax)),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------- documents (原始証憑) ----------
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  storage_path  text,                     -- path in the "receipts" bucket
  sha256        text,                     -- hash of the original file (duplicate detection, integrity)
  mime_type     text default '',
  original_name text default '',
  source        text not null default 'upload' check (source in ('camera','upload','drive','pdf','import','migrated')),
  drive_id      text,
  ocr_text      text,
  ocr_fields    jsonb,                    -- { field: { value, confidence, position } }
  created_at    timestamptz not null default now(),
  unique (user_id, storage_path)
);
create index if not exists documents_user_hash on public.documents (user_id, sha256);

-- ---------- transactions (取引) ----------
create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id),
  date        date,
  vendor      text not null default '',
  total       bigint,
  payment     text not null default 'unknown',
  status      text not null default 'draft' check (status in ('draft','ai_suggested','needs_review','confirmed','void')),
  source      text not null default 'manual' check (source in ('manual','ocr','ai','import','bank_csv','card_csv','migrated')),
  suggestion  jsonb,                      -- AI / rule suggestion: accounts, tax codes, confidence per field, reasons
  checks      jsonb,                      -- validation results (AMOUNT_MISMATCH, DUPLICATE_DOCUMENT …)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists transactions_user_date on public.transactions (user_id, date desc);

-- ---------- journal (仕訳) ----------
create table if not exists public.journal_entries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  transaction_id uuid references public.transactions(id),
  date           date not null,
  kind           text not null default 'normal' check (kind in ('normal','compound','transfer','closing','opening','carryforward','reversal')),
  status         text not null default 'draft' check (status in ('draft','posted','void')),
  source         text not null default 'manual' check (source in ('manual','ocr','ai','closing','import','migrated','system')),
  vendor         text not null default '',
  invoice_no     text not null default '',
  invoice_status text check (invoice_status in ('確認済','要確認','不備可能性','対象外')),
  memo           text not null default '',
  rule_version   text not null default '2026.1',
  reverses       uuid references public.journal_entries(id),   -- set on a reversal entry
  posted_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((kind = 'reversal') = (reverses is not null))
);
create index if not exists journal_entries_user_date on public.journal_entries (user_id, date);
create unique index if not exists journal_entries_one_reversal on public.journal_entries (reverses) where reverses is not null and status <> 'void';

create table if not exists public.journal_lines (
  id                 uuid primary key default gen_random_uuid(),
  entry_id           uuid not null references public.journal_entries(id),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  line_no            integer not null,
  account            text not null,
  dr                 bigint not null default 0 check (dr >= 0),
  cr                 bigint not null default 0 check (cr >= 0),
  tax_code           text not null default '-' check (public.valid_tax_code(tax_code)),
  tax_amount         bigint not null default 0,
  memo               text not null default '',
  allocation_rule_id uuid,
  check ((dr > 0) <> (cr > 0)),
  unique (entry_id, line_no)
);
create index if not exists journal_lines_user_account on public.journal_lines (user_id, account);

-- ---------- years, assets, rules ----------
create table if not exists public.fiscal_years (
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  year            integer not null check (year between 2000 and 2100),
  filing          text not null default 'blue65' check (filing in ('blue65','blue55','blue10','white')),
  ctax_status     text not null default 'taxable' check (ctax_status in ('exempt','taxable')),
  ctax_method     text not null default 'undecided' check (ctax_method in ('general','simplified','niwari','sanwari','undecided')),
  tax_inclusive   boolean not null default true,        -- 税込経理
  simplified_type integer check (simplified_type between 1 and 6),  -- 簡易課税 事業区分
  locked          boolean not null default false,
  locked_at       timestamptz,
  opening_entry_id uuid references public.journal_entries(id),
  updated_at      timestamptz not null default now(),
  primary key (user_id, year)
);

create table if not exists public.fixed_assets (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                 text not null,
  acquired             date not null,
  cost                 bigint not null check (cost > 0),
  account              text not null default '工具器具備品',
  asset_type           text not null default 'other',  -- preset key (pc, car, …)
  method               text not null default 'sl' check (method in ('sl','db','lump3','small')),
  life                 integer check (life between 2 and 50),
  biz_ratio            integer not null default 100 check (biz_ratio between 0 and 100),
  disposed             date,
  acquisition_entry_id uuid references public.journal_entries(id),
  document_id          uuid references public.documents(id),
  legacy_id            text,
  created_at           timestamptz not null default now(),
  unique (user_id, legacy_id)
);

create table if not exists public.allocation_rules (     -- 家事按分
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null,
  ratio      integer not null check (ratio between 0 and 100),   -- business share %
  valid_from date not null,
  valid_to   date,
  timing     text not null default 'immediate' check (timing in ('immediate','year_end')),
  reason     text not null default '',
  source     text not null default 'user',
  created_at timestamptz not null default now()
);

create table if not exists public.learning_rules (       -- 使用者修正學習: suggestion only, never tax rules
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  pattern    text not null,
  account    text not null,
  tax_code   text check (public.valid_tax_code(tax_code)),
  hits       integer not null default 1,
  updated_at timestamptz not null default now(),
  unique (user_id, pattern, account)
);

create table if not exists public.legacy_map (           -- old entries row → new journal entry (migration is idempotent)
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id        text not null,
  journal_entry_id uuid not null references public.journal_entries(id),
  primary key (user_id, legacy_id)
);

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb,
  at         timestamptz not null default now()
);
create index if not exists audit_log_user on public.audit_log (user_id, at desc);

-- ---------- integrity triggers ----------
create or replace function public.year_locked(uid uuid, d date) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select locked from public.fiscal_years where user_id = uid and year = extract(year from d)::int), false)
$$;

create or replace function public.account_exists(uid uuid, a text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_master where name = a)
      or exists (select 1 from public.accounts where user_id = uid and name = a and active)
$$;

create or replace function public.je_guard() returns trigger language plpgsql set search_path = public as $$
declare d bigint; c bigint; n int;
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purge', true) = 'on' then return old; end if;   -- permanent deletion through purge_journal
    raise exception 'journal entries are deleted only through purge_journal';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'a journal entry is created as draft, then posted'; end if;
    if public.year_locked(new.user_id, new.date) then raise exception 'year % is locked', extract(year from new.date); end if;
    return new;
  end if;
  -- UPDATE
  if old.status in ('posted','void') then
    raise exception 'a % journal entry cannot be changed (use a reversal entry)', old.status;
  end if;
  if new.user_id <> old.user_id or new.id <> old.id then raise exception 'owner and id cannot change'; end if;
  if public.year_locked(new.user_id, new.date) or public.year_locked(old.user_id, old.date) then
    raise exception 'year % is locked', extract(year from new.date);
  end if;
  if new.status = 'posted' then
    select coalesce(sum(dr),0), coalesce(sum(cr),0), count(*) into d, c, n from public.journal_lines where entry_id = new.id;
    if n < 2 then raise exception 'a journal entry needs at least two lines'; end if;
    if d <> c then raise exception 'debits (%) and credits (%) are not equal', d, c; end if;
    if new.reverses is not null and not exists (select 1 from public.journal_entries where id = new.reverses and status = 'posted' and user_id = new.user_id) then
      raise exception 'a reversal must point to a posted entry of the same user';
    end if;
    new.posted_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists je_guard on public.journal_entries;
create trigger je_guard before insert or update or delete on public.journal_entries
for each row execute function public.je_guard();

create or replace function public.jl_guard() returns trigger language plpgsql set search_path = public as $$
declare st text; owner uuid;
begin
  if tg_op = 'DELETE' and current_setting('app.purge', true) = 'on' then return old; end if;
  select status, user_id into st, owner from public.journal_entries where id = coalesce(new.entry_id, old.entry_id);
  if st is distinct from 'draft' then raise exception 'lines can change only while the entry is a draft'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and new.entry_id <> old.entry_id then raise exception 'a line cannot move to another entry'; end if;
  if new.user_id <> owner then raise exception 'line owner must match the entry'; end if;
  if not public.account_exists(new.user_id, new.account) then raise exception 'unknown account: %', new.account; end if;
  return new;
end $$;
drop trigger if exists jl_guard on public.journal_lines;
create trigger jl_guard before insert or update or delete on public.journal_lines
for each row execute function public.jl_guard();

create or replace function public.doc_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purge', true) = 'on' then return old; end if;
    raise exception 'documents are deleted only together with their entry (purge_journal)';
  end if;
  if new.storage_path is distinct from old.storage_path or new.sha256 is distinct from old.sha256 and old.sha256 is not null
     or new.user_id <> old.user_id or new.mime_type is distinct from old.mime_type then
    raise exception 'the original file of a document cannot change';
  end if;
  return new;
end $$;
drop trigger if exists doc_guard on public.documents;
create trigger doc_guard before update or delete on public.documents
for each row execute function public.doc_guard();

create or replace function public.no_delete() returns trigger language plpgsql as $$
begin
  if current_setting('app.purge', true) = 'on' then return old; end if;
  raise exception '% rows are deleted only through purge_journal', tg_table_name;
end $$;
drop trigger if exists tx_no_delete on public.transactions;
create trigger tx_no_delete before delete on public.transactions for each row execute function public.no_delete();

create or replace function public.custom_account_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.account_master where name = new.name) then raise exception '% is a standard account', new.name; end if;
  return new;
end $$;
drop trigger if exists custom_account_guard on public.accounts;
create trigger custom_account_guard before insert or update on public.accounts for each row execute function public.custom_account_guard();

create or replace function public.year_lock_stamp() returns trigger language plpgsql as $$
begin
  if new.locked and not coalesce(old.locked, false) then new.locked_at := now(); end if;
  if not new.locked then new.locked_at := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists year_lock_stamp on public.fiscal_years;
create trigger year_lock_stamp before insert or update on public.fiscal_years for each row execute function public.year_lock_stamp();

-- audit log for every table of the accounting core (unlocking a year is logged here too)
create or replace function public.audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  if current_setting('app.purge', true) = 'on' then return coalesce(new, old); end if;   -- a permanent deletion leaves no record
  insert into public.audit_log (user_id, table_name, row_id, action, old_row, new_row)
  values ((r->>'user_id')::uuid, tg_table_name, coalesce(r->>'id', r->>'year', r->>'legacy_id'), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['accounts','documents','transactions','journal_entries','journal_lines','fiscal_years','fixed_assets','allocation_rules','learning_rules'] loop
    execute format('drop trigger if exists audit_row on public.%I', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ---------- row-level security: each user sees only their own rows ----------
do $$ declare t text; begin
  foreach t in array array['accounts','documents','transactions','journal_entries','journal_lines','fiscal_years','fixed_assets','allocation_rules','learning_rules','legacy_map'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;
grant delete on public.journal_lines, public.allocation_rules, public.learning_rules, public.accounts to authenticated; -- draft lines and rules only (triggers guard the rest)

alter table public.account_master enable row level security;
drop policy if exists "read master" on public.account_master;
create policy "read master" on public.account_master for select using (true);
grant select on public.account_master to authenticated;

alter table public.audit_log enable row level security;
drop policy if exists "read own audit" on public.audit_log;
create policy "read own audit" on public.audit_log for select using (user_id = auth.uid());
grant select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated, anon;

-- ---------- version (the app checks it and asks to re-run this file when it is older than expected) ----------
create or replace function public.accounting_core_version() returns integer language sql immutable as $$ select 3 $$;
grant execute on function public.accounting_core_version() to authenticated;

-- ---------- import (used by the data upgrade now, and later by CSV import and backup restore) ----------
-- One call = one database transaction: everything is written, or nothing is. Runs with the caller's rights (RLS applies).
-- payload: { documents: [{storage_path, mime_type, source}],
--            entries: [{id, legacy_ids[], date, kind, source, vendor, invoice_no, invoice_status, memo, rule_version, reverses,
--                       transaction: {id, document_path, date, vendor, total, payment, status, source} | null,
--                       lines: [{account, dr, cr, tax_code, tax_amount, memo}]}],
--            fixed_assets: [...], fiscal_years: [...] }
-- Entries whose legacy_ids are already imported are skipped, so running it again is safe.
create or replace function public.import_journal(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  e jsonb; l jsonb; t jsonb;
  jid uuid; tid uuid; i int;
  posted int := 0; skipped int := 0;
begin
  if uid is null then raise exception 'sign in first'; end if;

  insert into documents (storage_path, mime_type, source)
    select d->>'storage_path', coalesce(d->>'mime_type', ''), coalesce(d->>'source', 'import')
    from jsonb_array_elements(coalesce(payload->'documents', '[]'::jsonb)) d
  on conflict (user_id, storage_path) do nothing;

  for e in select value from jsonb_array_elements(coalesce(payload->'entries', '[]'::jsonb)) loop
    if exists (select 1 from legacy_map m where m.user_id = uid
               and m.legacy_id in (select jsonb_array_elements_text(coalesce(e->'legacy_ids', '[]'::jsonb)))) then
      skipped := skipped + 1; continue;
    end if;
    t := e->'transaction'; tid := null;
    if t is not null and jsonb_typeof(t) = 'object' then
      tid := coalesce((t->>'id')::uuid, gen_random_uuid());
      insert into transactions (id, document_id, date, vendor, total, payment, status, source)
      values (tid,
              (select id from documents where user_id = uid and storage_path = t->>'document_path'),
              (t->>'date')::date, coalesce(t->>'vendor', ''), (t->>'total')::bigint, coalesce(t->>'payment', 'unknown'),
              coalesce(t->>'status', 'confirmed'), coalesce(t->>'source', 'import'));
    end if;
    jid := coalesce((e->>'id')::uuid, gen_random_uuid());
    insert into journal_entries (id, transaction_id, date, kind, source, vendor, invoice_no, invoice_status, memo, rule_version, reverses)
    values (jid, tid, (e->>'date')::date, coalesce(e->>'kind', 'normal'), coalesce(e->>'source', 'import'),
            coalesce(e->>'vendor', ''), coalesce(e->>'invoice_no', ''), e->>'invoice_status', coalesce(e->>'memo', ''),
            coalesce(e->>'rule_version', '2026.1'), (e->>'reverses')::uuid);
    i := 0;
    for l in select value from jsonb_array_elements(e->'lines') loop
      i := i + 1;
      insert into journal_lines (entry_id, line_no, account, dr, cr, tax_code, tax_amount, memo)
      values (jid, i, l->>'account', coalesce((l->>'dr')::bigint, 0), coalesce((l->>'cr')::bigint, 0),
              coalesce(l->>'tax_code', '-'), coalesce((l->>'tax_amount')::bigint, 0), coalesce(l->>'memo', ''));
    end loop;
    update journal_entries set status = 'posted' where id = jid;   -- the balance check runs here
    insert into legacy_map (legacy_id, journal_entry_id)
      select x, jid from jsonb_array_elements_text(coalesce(e->'legacy_ids', '[]'::jsonb)) x;
    posted := posted + 1;
  end loop;

  insert into fixed_assets (name, acquired, cost, account, asset_type, method, life, biz_ratio, legacy_id, acquisition_entry_id)
    select a->>'name', (a->>'acquired')::date, (a->>'cost')::bigint, coalesce(a->>'account', '工具器具備品'),
           coalesce(a->>'asset_type', 'other'), coalesce(a->>'method', 'sl'),
           case when (a->>'life') ~ '^\d+$' and (a->>'life')::int between 2 and 50 then (a->>'life')::int end,
           coalesce((a->>'biz_ratio')::int, 100), a->>'legacy_id',
           (select journal_entry_id from legacy_map where user_id = uid and legacy_id = 'asset:' || (a->>'legacy_id'))
    from jsonb_array_elements(coalesce(payload->'fixed_assets', '[]'::jsonb)) a
  on conflict (user_id, legacy_id) do nothing;

  insert into fiscal_years (year, filing, ctax_status, ctax_method, tax_inclusive, opening_entry_id)
    select (y->>'year')::int, coalesce(y->>'filing', 'blue65'), coalesce(y->>'ctax_status', 'taxable'),
           coalesce(y->>'ctax_method', 'undecided'), coalesce((y->>'tax_inclusive')::boolean, true),
           (select journal_entry_id from legacy_map where user_id = uid and legacy_id = 'opening:' || (y->>'year'))
    from jsonb_array_elements(coalesce(payload->'fiscal_years', '[]'::jsonb)) y
  on conflict (user_id, year) do update set
    opening_entry_id = coalesce(fiscal_years.opening_entry_id, excluded.opening_entry_id),
    filing = excluded.filing, ctax_status = excluded.ctax_status, ctax_method = excluded.ctax_method, tax_inclusive = excluded.tax_inclusive
    where not fiscal_years.locked;   -- until per-year settings exist (P4), the Settings page is the source

  return jsonb_build_object('posted', posted, 'skipped', skipped);
end $$;
revoke execute on function public.import_journal(jsonb) from public, anon;
grant execute on function public.import_journal(jsonb) to authenticated;

-- ---------- permanent deletion ----------
-- Removes the given entries together with their reversals (and the entries they reverse), their lines, the
-- legacy-map rows, and the transactions / documents nothing else uses. Nothing about them stays in audit_log.
-- Returns { entries: n, paths: [storage paths of removed documents] } so the app can delete those files.
create or replace function public.purge_journal(ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  all_ids uuid[]; line_ids uuid[]; tx_ids uuid[]; gone_tx uuid[]; doc_ids uuid[]; paths text[];
begin
  if uid is null then raise exception 'sign in first'; end if;
  select array_agg(distinct id) into all_ids from journal_entries
   where user_id = uid and (id = any(ids) or reverses = any(ids)
     or id in (select reverses from journal_entries where user_id = uid and id = any(ids) and reverses is not null));
  if all_ids is null then return jsonb_build_object('entries', 0, 'paths', '[]'::jsonb); end if;
  if exists (select 1 from journal_entries where id = any(all_ids) and public.year_locked(uid, date)) then
    raise exception 'a locked year cannot be changed';
  end if;
  perform set_config('app.purge', 'on', true);
  select array_agg(id) into line_ids from journal_lines where entry_id = any(all_ids);
  select array_agg(distinct transaction_id) into tx_ids from journal_entries where id = any(all_ids) and transaction_id is not null;
  delete from legacy_map where user_id = uid and journal_entry_id = any(all_ids);
  update fixed_assets set acquisition_entry_id = null where user_id = uid and acquisition_entry_id = any(all_ids);
  update fiscal_years set opening_entry_id = null where user_id = uid and opening_entry_id = any(all_ids);
  delete from journal_lines where entry_id = any(all_ids);
  delete from journal_entries where id = any(all_ids);
  -- transactions and documents that only these entries used
  select array_agg(id) into gone_tx from transactions t
   where t.user_id = uid and t.id = any(coalesce(tx_ids, '{}')) and not exists (select 1 from journal_entries j where j.transaction_id = t.id);
  select array_agg(distinct document_id) into doc_ids from transactions where id = any(coalesce(gone_tx, '{}')) and document_id is not null;
  delete from transactions where id = any(coalesce(gone_tx, '{}'));
  select array_agg(d.storage_path) into paths from documents d
   where d.user_id = uid and d.id = any(coalesce(doc_ids, '{}'))
     and not exists (select 1 from transactions t where t.document_id = d.id)
     and not exists (select 1 from fixed_assets f where f.document_id = d.id);
  delete from documents d where d.user_id = uid and d.storage_path = any(coalesce(paths, '{}'));
  delete from audit_log where user_id = uid and row_id = any(
    array(select unnest(all_ids)::text) || array(select unnest(coalesce(line_ids, '{}'))::text)
    || array(select unnest(coalesce(gone_tx, '{}'))::text) || array(select unnest(coalesce(doc_ids, '{}'))::text));
  return jsonb_build_object('entries', coalesce(array_length(all_ids, 1), 0), 'paths', to_jsonb(coalesce(paths, '{}')));
end $$;
revoke execute on function public.purge_journal(uuid[]) from public, anon;
grant execute on function public.purge_journal(uuid[]) to authenticated;

-- the change history of deleted records goes too
create or replace function public.purge_entry_history(ids text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'sign in first'; end if;
  delete from entry_history where user_id = uid and entry_id = any(ids) and not exists (select 1 from entries e where e.id = entry_history.entry_id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_entry_history(text[]) from public, anon;
grant execute on function public.purge_entry_history(text[]) to authenticated;

-- receipt images of deleted records can be removed (own folder only)
drop policy if exists "receipts delete own" on storage.objects;
create policy "receipts delete own" on storage.objects for delete
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
