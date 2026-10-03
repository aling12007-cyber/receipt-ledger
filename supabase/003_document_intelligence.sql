-- Receipt Ledger — Document Intelligence (run after schema.sql and 002_accounting_core.sql; safe to run again).
--
--   document_runs         one row per reading of a document: provider, model, prompt version, raw OCR with
--                         bounding boxes, structured result, field confidence, validation, quality, and the
--                         final (user-confirmed) result. What was read can never be changed afterwards.
--   document_field_edits  every change the user makes to a read value: original / AI / user value, who, when.
--   merchant_knowledge    the user's confirmed choices per normalized merchant (suggestions only — tax rules
--                         always win, and confirmed books are never changed by it).
--
-- Files: the original upload is kept untouched (original_path); the image shown on screen and read by OCR is a
-- separate processed copy (processed_path = entries.receipt_path). Deleting a record deletes both, and its rows
-- here, permanently (purge_document_records).

create table if not exists public.document_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  processed_path  text,                    -- image read by OCR and shown on screen (= entries.receipt_path)
  original_path   text,                    -- the untouched upload (photo, PDF, HEIC)
  sha256          text,                    -- hash of the original file
  dhash           text,                    -- perceptual hash of the image (finds re-photographed duplicates)
  doc_type        text not null default 'receipt'
                  check (doc_type in ('receipt','invoice','bill','delivery_note','credit_card_statement','bank_statement','contract','other')),
  provider        text not null,           -- e.g. tesseract, vision, pdf-text, ensemble
  model           text not null default '',
  prompt_version  text not null default '',
  engine_version  text not null default '',
  quality         jsonb,                   -- DocumentQuality
  raw_ocr         jsonb,                   -- per provider: text, words [{ text, confidence, bbox }]
  structured      jsonb,                   -- extraction (every field: value, confidence, bbox, source)
  confidence      jsonb,                   -- field → { score, level, reasons }
  validation      jsonb,                   -- { status, checks[] }
  status          text not null default 'ai_suggested'
                  check (status in ('ocr_result','ai_suggested','needs_review','user_confirmed','posted','rejected')),
  final           jsonb,                   -- what the user confirmed
  entry_ids       text[] not null default '{}',
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);
create index if not exists document_runs_user_path on public.document_runs (user_id, processed_path);
create index if not exists document_runs_user_hash on public.document_runs (user_id, sha256);
create index if not exists document_runs_user_dhash on public.document_runs (user_id, dhash);

create table if not exists public.document_field_edits (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id          uuid references public.document_runs(id) on delete cascade,
  processed_path  text,
  field           text not null,
  original_value  jsonb,                   -- what OCR read
  ai_value        jsonb,                   -- what was suggested (after parsing / AI)
  user_value      jsonb,                   -- what the user entered
  changed_by      uuid not null default auth.uid(),
  changed_at      timestamptz not null default now()
);
create index if not exists document_field_edits_run on public.document_field_edits (run_id);

create table if not exists public.merchant_knowledge (
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  merchant        text not null,           -- normalized merchant name
  account         text not null,
  raw_names       text[] not null default '{}',
  uses            integer not null default 1,
  last_used       timestamptz not null default now(),
  primary key (user_id, merchant, account)
);

revoke all on public.document_runs, public.document_field_edits, public.merchant_knowledge from anon;
grant select, insert, update on public.document_runs to authenticated;        -- updates limited by document_run_guard
grant select, insert on public.document_field_edits to authenticated;         -- insert-only audit trail
grant select, insert, update, delete on public.merchant_knowledge to authenticated;
alter table public.document_runs enable row level security;
alter table public.document_field_edits enable row level security;
alter table public.merchant_knowledge enable row level security;
drop policy if exists "own runs read" on public.document_runs;
create policy "own runs read" on public.document_runs for select using (user_id = auth.uid());
drop policy if exists "own runs insert" on public.document_runs;
create policy "own runs insert" on public.document_runs for insert with check (user_id = auth.uid());
drop policy if exists "own runs update" on public.document_runs;
create policy "own runs update" on public.document_runs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own edits read" on public.document_field_edits;
create policy "own edits read" on public.document_field_edits for select using (user_id = auth.uid());
drop policy if exists "own edits insert" on public.document_field_edits;
create policy "own edits insert" on public.document_field_edits for insert with check (user_id = auth.uid() and changed_by = auth.uid());
drop policy if exists "own merchants" on public.merchant_knowledge;
create policy "own merchants" on public.merchant_knowledge for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- What was read is permanent: only the review outcome (status, final, entry_ids, confirmed_at) may change.
create or replace function public.document_run_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.purge', true) = 'on' then return old; end if;
    raise exception 'document runs are deleted only with their record (purge_document_records)';
  end if;
  if (new.user_id, new.processed_path, new.original_path, new.sha256, new.dhash, new.doc_type, new.provider, new.model,
      new.prompt_version, new.engine_version, new.quality, new.raw_ocr, new.structured, new.confidence, new.validation, new.created_at)
     is distinct from
     (old.user_id, old.processed_path, old.original_path, old.sha256, old.dhash, old.doc_type, old.provider, old.model,
      old.prompt_version, old.engine_version, old.quality, old.raw_ocr, old.structured, old.confidence, old.validation, old.created_at) then
    raise exception 'what was read from a document cannot be changed; record the correction instead';
  end if;
  return new;
end $$;
drop trigger if exists document_run_guard on public.document_runs;
create trigger document_run_guard before update or delete on public.document_runs
for each row execute function public.document_run_guard();

create or replace function public.document_edit_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.purge', true) = 'on' then return old; end if;
  raise exception 'field edits are an audit trail and cannot be changed';
end $$;
drop trigger if exists document_edit_guard on public.document_field_edits;
create trigger document_edit_guard before update or delete on public.document_field_edits
for each row execute function public.document_edit_guard();

-- Permanent deletion of a record's document data: its runs, edits, and the storage paths (processed + original)
-- the caller should remove from the bucket.
create or replace function public.purge_document_records(paths text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  run_ids uuid[]; files text[];
begin
  if uid is null then raise exception 'sign in first'; end if;
  select array_agg(id), array_agg(distinct p) filter (where p is not null)
    into run_ids, files
    from document_runs r, lateral unnest(array[r.processed_path, r.original_path]) p
   where r.user_id = uid and r.processed_path = any(paths);
  if run_ids is null then return jsonb_build_object('runs', 0, 'paths', '[]'::jsonb); end if;
  perform set_config('app.purge', 'on', true);
  delete from document_field_edits where user_id = uid and run_id = any(run_ids);
  delete from document_runs where user_id = uid and id = any(run_ids);
  return jsonb_build_object('runs', (select count(distinct x) from unnest(run_ids) x), 'paths', to_jsonb(coalesce(files, '{}')));
end $$;
revoke execute on function public.purge_document_records(text[]) from public, anon;
grant execute on function public.purge_document_records(text[]) to authenticated;

create or replace function public.document_intelligence_version() returns integer language sql immutable as $$ select 1 $$;
grant execute on function public.document_intelligence_version() to authenticated;
