# Database tests

Run on a local Postgres 16 as a user that can create databases:

```
su postgres -c "sh supabase/tests/run.sh"
```

- `supabase_stub.sql` — minimal stand-ins for what Supabase provides (auth schema, `auth.uid()`, storage, roles).
- `accounting_core_test.sql` — integrity rules of `002_accounting_core.sql`: balance on posting, posted entries
  immutable, no deletes, locked years, documents, audit log, row-level security. Every line prints PASS or FAIL.
- `make_payload.mjs` + `run.sh` — the data upgrade end to end through `import_journal`: runs twice (the second run
  posts nothing), compares the trial balance in the database with the plan, and checks that one unbalanced entry
  rolls back the whole import.
