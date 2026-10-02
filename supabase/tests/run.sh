#!/bin/sh
# Database tests on a local Postgres 16 (run as a user who can create databases, e.g. `su postgres -c sh supabase/tests/run.sh`).
set -e
cd "$(dirname "$0")/../.."
DB=receipt_ledger_test
psql -qc "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f supabase/tests/supabase_stub.sql -f supabase/schema.sql -f supabase/002_accounting_core.sql -f supabase/002_accounting_core.sql 2>&1 | grep -v NOTICE || true
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
