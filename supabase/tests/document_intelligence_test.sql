-- Behaviour test for 003_document_intelligence.sql. Every check prints PASS or FAIL.
\set ON_ERROR_STOP 0
\pset tuples_only on
insert into auth.users values ('66666666-6666-6666-6666-666666666666'),('77777777-7777-7777-7777-777777777777') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
create or replace function pg_temp.expect_error(sql text, label text) returns text language plpgsql as $$
begin execute sql; return 'FAIL  ' || label || ' (no error)';
exception when others then return 'PASS  ' || label || ' → ' || sqlerrm; end $$;

select case when public.document_intelligence_version() = 1 then 'PASS  version 1' else 'FAIL  version' end;
insert into document_runs (id, processed_path, original_path, sha256, provider, model, prompt_version, raw_ocr, structured, validation)
values ('dddddddd-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666/2026-09/a.jpg', '66666666-6666-6666-6666-666666666666/2026-09/a.orig.heic',
        'abc', 'tesseract', 'tesseract.js-5', 'receipt-parser-v1', '{"text":"合計 1,100"}', '{"total":{"value":1100}}', '{"status":"ok"}');
update document_runs set status = 'user_confirmed', final = '{"total":1100}', entry_ids = '{e1}', confirmed_at = now() where id = 'dddddddd-0000-0000-0000-000000000001';
select case when status = 'user_confirmed' and entry_ids = '{e1}' then 'PASS  review outcome can be recorded' else 'FAIL  review outcome' end from document_runs;
select pg_temp.expect_error($$update document_runs set structured = '{"total":{"value":9}}'$$, 'what was read cannot be changed');
select pg_temp.expect_error($$update document_runs set raw_ocr = null$$, 'raw OCR cannot be erased');
select pg_temp.expect_error($$delete from document_runs$$, 'runs are not deleted directly');
insert into document_field_edits (run_id, processed_path, field, original_value, ai_value, user_value)
values ('dddddddd-0000-0000-0000-000000000001', '66666666-6666-6666-6666-666666666666/2026-09/a.jpg', 'total', '1100', '1100', '1180');
select case when changed_by = '66666666-6666-6666-6666-666666666666' and changed_at is not null then 'PASS  edit records who and when' else 'FAIL  edit audit' end from document_field_edits;
select pg_temp.expect_error($$update document_field_edits set user_value = '1'$$, 'edits cannot be changed');
select pg_temp.expect_error($$insert into document_field_edits (field, changed_by) values ('x', '77777777-7777-7777-7777-777777777777')$$, 'cannot write an edit as someone else');
set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
select case when count(*) = 0 then 'PASS  other users see nothing' else 'FAIL  RLS' end from document_runs;
select case when (public.purge_document_records(array['66666666-6666-6666-6666-666666666666/2026-09/a.jpg']))->>'runs' = '0' then 'PASS  other users cannot purge' else 'FAIL  cross-user purge' end;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
select case when (select jsonb_array_length(r->'paths')) = 2 and r->>'runs' = '1' then 'PASS  purge returns processed and original file' else 'FAIL  purge result ' || r::text end
  from (select public.purge_document_records(array['66666666-6666-6666-6666-666666666666/2026-09/a.jpg']) r) x;
select case when (select count(*) from document_runs) = 0 and (select count(*) from document_field_edits) = 0 then 'PASS  runs and edits are gone' else 'FAIL  leftovers' end;
insert into merchant_knowledge (merchant, account, raw_names) values ('ローソン', '会議費', '{ローソン 新宿店}')
  on conflict (user_id, merchant, account) do update set uses = merchant_knowledge.uses + 1;
insert into merchant_knowledge (merchant, account, raw_names) values ('ローソン', '会議費', '{LAWSON}')
  on conflict (user_id, merchant, account) do update set uses = merchant_knowledge.uses + 1;
select case when uses = 2 then 'PASS  merchant knowledge counts confirmations' else 'FAIL  merchant knowledge' end from merchant_knowledge;
