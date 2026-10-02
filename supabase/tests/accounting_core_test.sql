-- Behaviour test for 002_accounting_core.sql on a local Postgres with Supabase-like stubs
-- (see supabase/tests/README.md). Every check prints PASS or FAIL.
\set ON_ERROR_STOP 0
\pset tuples_only on
grant usage on schema public, auth to authenticated;
insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create or replace function pg_temp.expect_error(sql text, label text) returns text language plpgsql as $$
begin execute sql; return 'FAIL  ' || label || ' (no error)';
exception when others then return 'PASS  ' || label || ' → ' || sqlerrm; end $$;

-- a balanced entry: draft → lines → posted
insert into journal_entries (id, date, memo) values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-01-10', '文具');
insert into journal_lines (entry_id, line_no, account, dr, tax_code, tax_amount) values ('aaaaaaaa-0000-0000-0000-000000000001', 1, '消耗品費', 3300, 'P10', 300);
insert into journal_lines (entry_id, line_no, account, cr) values ('aaaaaaaa-0000-0000-0000-000000000001', 2, '現金', 3300);
update journal_entries set status = 'posted' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when status = 'posted' and posted_at is not null then 'PASS  balanced entry posts' else 'FAIL  balanced entry posts' end from journal_entries where id = 'aaaaaaaa-0000-0000-0000-000000000001';

select pg_temp.expect_error($$insert into journal_entries (date, status) values ('2026-01-11','posted')$$, 'cannot insert as posted');
select pg_temp.expect_error($$update journal_entries set memo = 'x' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'posted entry is immutable');
select pg_temp.expect_error($$delete from journal_entries where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'entries are never deleted');
select pg_temp.expect_error($$update journal_lines set dr = 1 where entry_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'lines of a posted entry are immutable');
select pg_temp.expect_error($$delete from journal_lines where entry_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'lines of a posted entry cannot be deleted');

-- unbalanced entry cannot post
insert into journal_entries (id, date) values ('aaaaaaaa-0000-0000-0000-000000000002', '2026-01-12');
insert into journal_lines (entry_id, line_no, account, dr) values ('aaaaaaaa-0000-0000-0000-000000000002', 1, '消耗品費', 1000);
insert into journal_lines (entry_id, line_no, account, cr) values ('aaaaaaaa-0000-0000-0000-000000000002', 2, '現金', 900);
select pg_temp.expect_error($$update journal_entries set status = 'posted' where id = 'aaaaaaaa-0000-0000-0000-000000000002'$$, 'unbalanced entry cannot post');
select pg_temp.expect_error($$insert into journal_lines (entry_id, line_no, account, dr) values ('aaaaaaaa-0000-0000-0000-000000000002', 3, '存在しない科目', 100)$$, 'unknown account refused');
select pg_temp.expect_error($$insert into journal_lines (entry_id, line_no, account, dr, cr) values ('aaaaaaaa-0000-0000-0000-000000000002', 4, '現金', 100, 100)$$, 'line must be debit or credit');
select pg_temp.expect_error($$insert into journal_lines (entry_id, line_no, account, dr, tax_code) values ('aaaaaaaa-0000-0000-0000-000000000002', 5, '現金', 100, 'X99')$$, 'unknown tax code refused');
update journal_entries set status = 'void' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select case when status = 'void' then 'PASS  draft can be voided' else 'FAIL  draft can be voided' end from journal_entries where id = 'aaaaaaaa-0000-0000-0000-000000000002';

-- correction = reversal entry pointing at the posted one
insert into journal_entries (id, date, kind, reverses) values ('aaaaaaaa-0000-0000-0000-000000000003', '2026-01-20', 'reversal', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into journal_lines (entry_id, line_no, account, cr, tax_code, tax_amount) values ('aaaaaaaa-0000-0000-0000-000000000003', 1, '消耗品費', 3300, 'P10', 300);
insert into journal_lines (entry_id, line_no, account, dr) values ('aaaaaaaa-0000-0000-0000-000000000003', 2, '現金', 3300);
update journal_entries set status = 'posted' where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select case when count(*) = 1 then 'PASS  reversal posts' else 'FAIL  reversal posts' end from journal_entries where id = 'aaaaaaaa-0000-0000-0000-000000000003' and status = 'posted';
select pg_temp.expect_error($$insert into journal_entries (date, kind, reverses) values ('2026-01-21', 'reversal', 'aaaaaaaa-0000-0000-0000-000000000001')$$, 'only one reversal per entry');

-- custom account
insert into accounts (name, type, default_tax) values ('サブスク費', 'expense', 'P10');
insert into journal_entries (id, date) values ('aaaaaaaa-0000-0000-0000-000000000004', '2026-02-01');
insert into journal_lines (entry_id, line_no, account, dr, tax_code, tax_amount) values ('aaaaaaaa-0000-0000-0000-000000000004', 1, 'サブスク費', 1100, 'P10', 100);
select case when count(*) = 1 then 'PASS  custom account usable' else 'FAIL  custom account usable' end from journal_lines where account = 'サブスク費';
select pg_temp.expect_error($$insert into accounts (name, type) values ('現金', 'asset')$$, 'custom account cannot shadow a standard one');

-- year lock
insert into fiscal_years (year, locked) values (2025, true);
select pg_temp.expect_error($$insert into journal_entries (date) values ('2025-12-31')$$, 'nothing written into a locked year');
update fiscal_years set locked = false where year = 2025;
insert into journal_entries (date) values ('2025-12-31');
select case when count(*) >= 2 then 'PASS  lock and unlock are in the audit log' else 'FAIL  lock/unlock audit' end from audit_log where table_name = 'fiscal_years';

-- documents
insert into documents (id, storage_path, sha256) values ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111/2026-01/a.jpg', 'abc');
update documents set ocr_text = '領収書' where id = 'dddddddd-0000-0000-0000-000000000001';
select case when ocr_text = '領収書' then 'PASS  OCR text can be added' else 'FAIL  OCR text' end from documents where id = 'dddddddd-0000-0000-0000-000000000001';
select pg_temp.expect_error($$update documents set storage_path = 'other.jpg' where id = 'dddddddd-0000-0000-0000-000000000001'$$, 'original file cannot change');
select pg_temp.expect_error($$delete from documents where id = 'dddddddd-0000-0000-0000-000000000001'$$, 'documents are never deleted');

-- audit log is read-only
select pg_temp.expect_error($$delete from audit_log$$, 'audit log cannot be deleted');
select pg_temp.expect_error($$update audit_log set action = 'x'$$, 'audit log cannot be changed');

-- another user sees nothing and cannot write into this user's entry
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select case when (select count(*) from journal_entries) + (select count(*) from journal_lines) + (select count(*) from documents) + (select count(*) from audit_log) = 0
  then 'PASS  other user sees nothing' else 'FAIL  other user sees rows' end;
select pg_temp.expect_error($$insert into journal_lines (entry_id, line_no, account, dr, user_id) values ('aaaaaaaa-0000-0000-0000-000000000004', 9, '現金', 1, '11111111-1111-1111-1111-111111111111')$$, 'cannot write lines for another user');
select pg_temp.expect_error($$insert into journal_lines (entry_id, line_no, account, dr) values ('aaaaaaaa-0000-0000-0000-000000000004', 9, '現金', 1)$$, 'cannot attach lines to another user''s entry');
