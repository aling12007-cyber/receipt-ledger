// LedgerService against an in-memory stand-in for the Supabase client that applies the same posting rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const LedgerService = load("engine/ledger-service.js");
const Journal = load("engine/journal.js");

function fakeSupabase({ tables = true } = {}) {
  const db = { entries: [], keys: new Set(), calls: 0 };
  return {
    db,
    from(t) {
      const q = { _t: t, select() { return q; }, gte() { return q; }, lte() { return q; }, neq() { return q; }, order() { return q; },
        range() { return Promise.resolve({ data: db.entries.map((e) => ({ ...e, journal_lines: e.lines.map((l, i) => ({ ...l, line_no: i + 1 })) })), error: null }); },
        then(res) { return res(tables ? { count: db.entries.length, error: null } : { error: { message: "relation does not exist" } }); } };
      return q;
    },
    rpc(name, args) {
      db.calls++;
      if (name === "purge_journal") {
        const ids = new Set(db.entries.filter((e) => args.ids.includes(e.id) || args.ids.includes(e.reverses)).map((e) => e.id));
        db.entries = db.entries.filter((e) => !ids.has(e.id));
        return Promise.resolve({ data: { entries: ids.size, paths: [] }, error: null });
      }
      const { payload } = args;
      let posted = 0, skipped = 0;
      for (const e of payload.entries) {
        if (e.legacy_ids.some((k) => db.keys.has(k))) { skipped++; continue; }
        const dr = e.lines.reduce((s, l) => s + l.dr, 0), cr = e.lines.reduce((s, l) => s + l.cr, 0);
        if (dr !== cr) return Promise.resolve({ data: null, error: { message: `debits (${dr}) and credits (${cr}) are not equal` } });
        e.legacy_ids.forEach((k) => db.keys.add(k)); db.entries.push({ ...e, status: "posted" }); posted++;
      }
      return Promise.resolve({ data: { posted, skipped }, error: null });
    },
  };
}
let n = 0;
const uuid = () => "id-" + ++n;

test("reports whether the accounting-core tables exist", async () => {
  assert.equal(await LedgerService.create(fakeSupabase(), { uuid }).isAvailable(), true);
  assert.equal(await LedgerService.create(fakeSupabase({ tables: false }), { uuid }).isAvailable(), false);
});

test("posts a valid entry once, even when retried with the same key", async () => {
  const sb = fakeSupabase(), svc = LedgerService.create(sb, { uuid });
  const { entry } = Journal.fromQuickEntry({ date: "2026-10-01", amount: 1100, account: "消耗品費", payment: "cash" });
  const a = await svc.post(entry, { key: "q1" }), b = await svc.post(entry, { key: "q1" });
  assert.deepEqual([a.posted, b.duplicate, sb.db.entries.length], [true, true, 1]);
});

test("an invalid entry never reaches the database", async () => {
  const sb = fakeSupabase(), svc = LedgerService.create(sb, { uuid });
  const bad = { date: "2026-10-01", kind: "normal", vendor: "", invoice_no: "", memo: "", lines: [{ account: "消耗品費", dr: 100, cr: 0, tax_code: "P10", tax_amount: 9 }, { account: "現金", dr: 0, cr: 90, tax_code: "-", tax_amount: 0 }] };
  await assert.rejects(svc.post(bad), (e) => e.code === "INVALID" && e.errors[0].code === "UNBALANCED");
  assert.equal(sb.db.calls, 0);
});

test("correction overwrites: the old entry is deleted, only the corrected one remains", async () => {
  const sb = fakeSupabase(), svc = LedgerService.create(sb, { uuid });
  const first = Journal.fromQuickEntry({ date: "2026-10-01", amount: 8800, account: "通信費", payment: "bank", bizRatio: 60 }).entry;
  const { id } = await svc.post(first, { key: "phone" });
  const [posted] = await svc.list(2026);
  assert.equal(posted.id, id);
  const fixed = Journal.fromQuickEntry({ date: "2026-10-01", amount: 8800, account: "通信費", payment: "bank", bizRatio: 50 }).entry;
  await svc.correct(posted, fixed);
  const all = await svc.list(2026);
  assert.deepEqual(all.map((e) => e.kind), ["compound"]); // 家事按分 adds a 事業主貸 line
  assert.notEqual(all[0].id, posted.id);
  assert.deepEqual(Journal.balances(all), Journal.balances([fixed]));
});

test("delete removes an entry permanently, together with its reversal", async () => {
  const sb = fakeSupabase(), svc = LedgerService.create(sb, { uuid });
  const { entry } = Journal.fromQuickEntry({ type: "transfer", date: "2026-10-01", amount: 50000, from: "普通預金", to: "事業主貸" });
  await svc.post(entry, { key: "t1" });
  const [posted] = await svc.list(2026);
  await svc.reverse(posted);
  const out = await svc.remove(posted);
  assert.equal(out.removed, 2);
  assert.deepEqual(await svc.list(2026), []);
});
