#!/bin/sh
# Database tests on a local Postgres 16 (run as a user who can create databases, e.g. `su postgres -c sh supabase/tests/run.sh`).
set -e
cd "$(dirname "$0")/../.."
DB=receipt_ledger_test
psql -qc "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f supabase/tests/supabase_stub.sql -f supabase/schema.sql -f supabase/002_accounting_core.sql -f supabase/002_accounting_core.sql -f supabase/003_document_intelligence.sql -f supabase/003_document_intelligence.sql 2>&1 | grep -v NOTICE || true
echo "--- integrity rules"
psql -q -d $DB -f supabase/tests/accounting_core_test.sql 2>&1 | sed 's/^ *//' | grep -v '^$'
echo "--- data upgrade through import_journal"
node supabase/tests/make_payload.mjs > /tmp/rl_payload.json
psql -q -d $DB -v ON_ERROR_STOP=1 <<SQL | sed 's/^ *//' | grep -v '^$'
\pset tuples_only on
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
\set content \`cat /tmp/rl_payload.json\`
create temp table p as select (:'content')::jsonb as j;
select 'first run:  ' || public.import_journal((select j->'payload' from p))::text;
select 'second run: ' || public.import_journal((select j->'payload' from p))::text;
select case when count(*) = (select (j->>'count')::int from p) then 'PASS  every entry posted once' else 'FAIL  entry count ' || count(*) end
  from journal_entries where status = 'posted';
with got as (select account, sum(dr - cr) v from journal_lines group by account having sum(dr - cr) <> 0),
     want as (select key account, value::bigint v from p, jsonb_each_text(p.j->'tb') where value::bigint <> 0)
select case when not exists (select * from got full join want using (account) where got.v is distinct from want.v)
  then 'PASS  trial balance in the database equals the plan' else 'FAIL  trial balance differs' end;
select case when count(*) = 1 then 'PASS  compound receipt kept as one entry with its document' else 'FAIL  compound receipt' end
  from journal_entries je join transactions t on t.id = je.transaction_id join documents d on d.id = t.document_id where je.kind = 'compound';
select case when count(*) = 1 and bool_and(acquisition_entry_id is not null) then 'PASS  fixed asset linked to its acquisition entry' else 'FAIL  fixed asset' end from fixed_assets;
select case when opening_entry_id is not null and ctax_method = 'general' then 'PASS  fiscal year with opening entry and settings' else 'FAIL  fiscal year' end from fiscal_years where year = 2026;
SQL
echo "--- a bad entry rolls back the whole import"
psql -q -d $DB -c "insert into auth.users values ('33333333-3333-3333-3333-333333333333') on conflict do nothing"
psql -q -d $DB <<'SQL' 2>&1 | sed 's/^ *//' | grep -E 'PASS|FAIL|ERROR' | sed 's/^ERROR: */import refused: /'
\pset tuples_only on
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.import_journal('{"entries":[
  {"legacy_ids":["ok"],"date":"2026-01-01","lines":[{"account":"消耗品費","dr":100},{"account":"現金","cr":100}]},
  {"legacy_ids":["bad"],"date":"2026-01-02","lines":[{"account":"消耗品費","dr":100},{"account":"現金","cr":90}]}]}'::jsonb);
select case when count(*) = 0 then 'PASS  nothing was written' else 'FAIL  partial import' end from journal_entries;
SQL
echo "--- reversal entries through import_journal"
psql -q -d $DB <<'SQL' 2>&1 | sed 's/^ *//' | grep -E 'PASS|FAIL|ERROR' | sed 's/^ERROR: */refused: /'
\pset tuples_only on
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select case when public.accounting_core_version() >= 2 then 'PASS  version 2' else 'FAIL  version' end;
select public.import_journal('{"entries":[{"id":"bbbbbbbb-0000-0000-0000-000000000001","legacy_ids":["r1"],"date":"2026-03-01","lines":[{"account":"消耗品費","dr":1100,"tax_code":"P10","tax_amount":100},{"account":"現金","cr":1100}]}]}'::jsonb) is not null;
select public.import_journal('{"entries":[{"legacy_ids":["rev:1"],"date":"2026-03-01","kind":"reversal","reverses":"bbbbbbbb-0000-0000-0000-000000000001","lines":[{"account":"消耗品費","cr":1100,"tax_code":"P10","tax_amount":100},{"account":"現金","dr":1100}]}]}'::jsonb) is not null;
select case when count(*) = 1 then 'PASS  reversal posted and linked' else 'FAIL  reversal' end from journal_entries where kind = 'reversal' and reverses = 'bbbbbbbb-0000-0000-0000-000000000001' and status = 'posted';
select case when coalesce(sum(dr - cr), 0) = 0 then 'PASS  reversal cancels the entry' else 'FAIL  balance' end from journal_lines;
select public.import_journal('{"entries":[{"legacy_ids":["rev:again"],"date":"2026-03-01","kind":"reversal","reverses":"bbbbbbbb-0000-0000-0000-000000000001","lines":[{"account":"消耗品費","cr":1100},{"account":"現金","dr":1100}]}]}'::jsonb);
SQL
echo "--- permanent deletion (purge_journal)"
psql -q -d $DB -c "insert into auth.users values ('44444444-4444-4444-4444-444444444444'),('55555555-5555-5555-5555-555555555555') on conflict do nothing"
psql -q -d $DB <<'SQL' 2>&1 | sed 's/^ *//' | grep -E 'PASS|FAIL|ERROR' | sed 's/^ERROR: */refused: /'
\pset tuples_only on
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select public.import_journal('{"documents":[{"storage_path":"44444444-4444-4444-4444-444444444444/2026-03/r.jpg"}],
  "entries":[{"id":"cccccccc-0000-0000-0000-000000000001","legacy_ids":["row1"],"date":"2026-03-01","source":"migrated",
    "transaction":{"document_path":"44444444-4444-4444-4444-444444444444/2026-03/r.jpg","date":"2026-03-01","status":"confirmed","source":"migrated"},
    "lines":[{"account":"消耗品費","dr":1100,"tax_code":"P10","tax_amount":100},{"account":"現金","cr":1100}]},
   {"id":"cccccccc-0000-0000-0000-000000000002","legacy_ids":["row2"],"date":"2026-03-02","lines":[{"account":"消耗品費","dr":500},{"account":"現金","cr":500}]}]}'::jsonb) is not null;
select public.import_journal('{"entries":[{"legacy_ids":["rev:x"],"date":"2026-03-05","kind":"reversal","reverses":"cccccccc-0000-0000-0000-000000000001","lines":[{"account":"消耗品費","cr":1100,"tax_code":"P10","tax_amount":100},{"account":"現金","dr":1100}]}]}'::jsonb) is not null;
select case when (public.purge_journal(array['cccccccc-0000-0000-0000-000000000001']::uuid[]))->>'entries' = '2' then 'PASS  entry and its reversal purged together' else 'FAIL  purge count' end;
select case when count(*) = 1 then 'PASS  the other entry stays' else 'FAIL  other entries: ' || count(*) end from journal_entries;
select case when (select count(*) from journal_lines) = 2 and (select count(*) from legacy_map) = 1 then 'PASS  lines and legacy map of the purged entries are gone' else 'FAIL  leftovers' end;
select case when (select count(*) from transactions) = 0 and (select count(*) from documents) = 0 then 'PASS  transaction and document used only by it are gone' else 'FAIL  transaction/document left' end;
select case when not exists (select 1 from audit_log where row_id in ('cccccccc-0000-0000-0000-000000000001')) then 'PASS  no trace in the audit log' else 'FAIL  audit trace' end;
select case when coalesce(sum(dr - cr), 0) = 0 and coalesce(sum(dr), 0) = 500 then 'PASS  trial balance contains only the remaining entry' else 'FAIL  balance' end from journal_lines;
delete from journal_entries;
select case when count(*) = 1 then 'PASS  a plain DELETE is still refused' else 'FAIL  plain delete worked' end from journal_entries;
insert into fiscal_years (year, locked) values (2026, true) on conflict (user_id, year) do update set locked = true;
select public.purge_journal(array['cccccccc-0000-0000-0000-000000000002']::uuid[]);
update fiscal_years set locked = false where year = 2026;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select case when (public.purge_journal(array['cccccccc-0000-0000-0000-000000000002']::uuid[]))->>'entries' = '0' then 'PASS  another user cannot purge it' else 'FAIL  cross-user purge' end;
SQL
echo "--- document intelligence (003)"
psql -q -d $DB -f supabase/tests/document_intelligence_test.sql 2>&1 | sed 's/^ *//' | grep -E 'PASS|FAIL|ERROR'
echo "--- transactions keep the document's suggestion and checks (version 4)"
psql -q -d $DB <<'SQL' 2>&1 | sed 's/^ *//' | grep -E 'PASS|FAIL|ERROR'
\pset tuples_only on
set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select case when public.accounting_core_version() >= 4 then 'PASS  version 4' else 'FAIL  version' end;
select public.import_journal('{"documents":[{"storage_path":"55555555-5555-5555-5555-555555555555/2026-09/s.jpg"}],
  "entries":[{"legacy_ids":["sx1"],"date":"2026-09-28","source":"migrated",
    "transaction":{"document_path":"55555555-5555-5555-5555-555555555555/2026-09/s.jpg","date":"2026-09-28","payment":"card","status":"confirmed","source":"ocr",
      "suggestion":{"account":"会議費","confidence":0.82,"source":"history"},"checks":{"status":"ok"}},
    "lines":[{"account":"会議費","dr":1100,"tax_code":"P10","tax_amount":100},{"account":"未払金","cr":1100}]}]}'::jsonb) is not null;
select case when t.payment = 'card' and t.source = 'ocr' and t.suggestion->>'account' = '会議費' and t.checks->>'status' = 'ok' and t.document_id is not null
  then 'PASS  receipt → transaction (suggestion, checks, document) → journal entry' else 'FAIL  transaction fields' end
  from transactions t join journal_entries j on j.transaction_id = t.id where j.date = '2026-09-28';
SQL
