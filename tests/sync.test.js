// Sync (engine/sync.js): the journal follows edits and deletions of old rows by reversal, never by changing entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const Books = load("books.js"), Filing = load("filing.js"), Sync = load("engine/sync.js");
let n = 0;
const deps = { Books, Filing, uuid: () => "u" + ++n };

// in-memory database applying import_journal's rules (skip known legacy ids, post atomically)
function fakeDb() {
  const db = { entries: [], map: [] };
  const apply = (payload) => {
    for (const e of payload.entries) {
      if (e.legacy_ids.some((k) => db.map.some((m) => m.legacy_id === k))) continue;
      db.entries.push({ ...e, status: "posted", lines: e.lines.map((l) => ({ ...l })) });
      e.legacy_ids.forEach((k) => db.map.push({ legacy_id: k, journal_entry_id: e.id }));
    }
  };
  return { db, step(rows) { const p = Sync.plan(rows, {}, db, deps); apply(p.payload); return p; } };
}
const row = (id, amt10, extra = {}) => ({ id, type: "expense", date: "2026-03-01", debit: "消耗品費", credit: "現金", amt10, amt8: 0, amt0: 0, bizRatio: 100, ...extra });
const check = (db, rows) => assert.deepEqual(Sync.diff(Sync.balances(db.entries), Sync.balances(Sync.plan(rows, {}, { entries: [], map: [] }, deps).target.entries)), []);

test("new rows are posted; a second run changes nothing", () => {
  const f = fakeDb(), rows = [row("a", 1100), row("b", 2200)];
  assert.deepEqual(f.step(rows).counts, { added: 2, changed: 0, removed: 0, unchanged: 0 });
  assert.deepEqual(f.step(rows).counts, { added: 0, changed: 0, removed: 0, unchanged: 2 });
  check(f.db, rows);
});

test("an edited row: the old entry is reversed and the corrected one posted", () => {
  const f = fakeDb();
  f.step([row("a", 1100)]);
  const p = f.step([row("a", 3300)]);
  assert.deepEqual(p.counts, { added: 0, changed: 1, removed: 0, unchanged: 0 });
  assert.deepEqual(f.db.entries.map((e) => e.kind), ["normal", "reversal", "normal"]);
  assert.equal(f.db.entries[1].reverses, f.db.entries[0].id);
  check(f.db, [row("a", 3300)]);
  assert.deepEqual(f.step([row("a", 3300)]).counts.unchanged, 1);
});

test("edit back and forth never collides with an earlier correction", () => {
  const f = fakeDb();
  for (const amt of [1100, 2200, 1100, 2200, 1100]) { f.step([row("a", amt)]); check(f.db, [row("a", amt)]); }
  assert.equal(f.db.entries.filter((e) => e.kind === "reversal").length, 4);
});

test("a deleted row is reversed", () => {
  const f = fakeDb();
  f.step([row("a", 1100), row("b", 2200)]);
  assert.deepEqual(f.step([row("b", 2200)]).counts, { added: 0, changed: 0, removed: 1, unchanged: 1 });
  check(f.db, [row("b", 2200)]);
});

test("changing one split line of a receipt re-posts the whole compound entry", () => {
  const f = fakeDb(), r = (id, debit, amt, k) => row(id, 0, { debit, [k]: amt, assetId: "img1" });
  f.step([r("x", "消耗品費", 715, "amt10"), r("y", "租税公課", 200, "amt0")]);
  const p = f.step([r("x", "消耗品費", 715, "amt10"), r("y", "租税公課", 400, "amt0")]);
  assert.deepEqual(p.counts.changed, 1);
  check(f.db, [r("x", "消耗品費", 715, "amt10"), r("y", "租税公課", 400, "amt0")]);
});

test("entries made in the new books (not migrated) are never touched", () => {
  const f = fakeDb();
  f.db.entries.push({ id: "manual1", date: "2026-03-02", kind: "transfer", status: "posted", source: "manual", lines: [{ account: "事業主貸", dr: 500, cr: 0, tax_code: "-", tax_amount: 0 }, { account: "普通預金", dr: 0, cr: 500, tax_code: "-", tax_amount: 0 }] });
  f.db.map.push({ legacy_id: "app:k1", journal_entry_id: "manual1" });
  assert.deepEqual(f.step([row("a", 1100)]).counts, { added: 1, changed: 0, removed: 0, unchanged: 0 });
  assert.equal(f.db.entries.filter((e) => e.kind === "reversal").length, 0);
});
