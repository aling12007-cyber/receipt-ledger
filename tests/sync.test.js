// Sync (engine/sync.js): an edited row replaces its old entry (no reversal); deleted rows are removed from the journal for good.
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
  const purge = (ids) => { db.entries = db.entries.filter((e) => !ids.includes(e.id)); db.map = db.map.filter((m) => !ids.includes(m.journal_entry_id)); };
  return { db, step(rows) { const p = Sync.plan(rows, {}, db, deps); purge(p.purge); apply(p.payload); return p; } };
}
const row = (id, amt10, extra = {}) => ({ id, type: "expense", date: "2026-03-01", debit: "消耗品費", credit: "現金", amt10, amt8: 0, amt0: 0, bizRatio: 100, ...extra });
const check = (db, rows) => assert.deepEqual(Sync.diff(Sync.balances(db.entries), Sync.balances(Sync.plan(rows, {}, { entries: [], map: [] }, deps).target.entries)), []);

test("new rows are posted; a second run changes nothing", () => {
  const f = fakeDb(), rows = [row("a", 1100), row("b", 2200)];
  assert.deepEqual(f.step(rows).counts, { added: 2, changed: 0, removed: 0, unchanged: 0 });
  assert.deepEqual(f.step(rows).counts, { added: 0, changed: 0, removed: 0, unchanged: 2 });
  check(f.db, rows);
});

test("an edited row overwrites: the old entry is gone, no reversal, only the new version", () => {
  const f = fakeDb();
  f.step([row("a", 1100)]);
  const old = f.db.entries[0].id;
  const p = f.step([row("a", 3300)]);
  assert.deepEqual(p.counts, { added: 0, changed: 1, removed: 0, unchanged: 0 });
  assert.deepEqual(f.db.entries.map((e) => e.kind), ["normal"]);
  assert.notEqual(f.db.entries[0].id, old);
  assert.deepEqual(f.db.map.map((m) => m.legacy_id), ["a"]);
  check(f.db, [row("a", 3300)]);
  assert.deepEqual(f.step([row("a", 3300)]).counts.unchanged, 1);
});

test("changing the account: the old account disappears from the books", () => {
  const f = fakeDb();
  f.step([row("a", 1100)]);
  f.step([row("a", 1100, { debit: "会議費" })]);
  const accts = f.db.entries.flatMap((e) => e.lines.map((l) => l.account));
  assert.ok(!accts.includes("消耗品費"));
  assert.ok(accts.includes("会議費"));
});

test("edit back and forth never collides and leaves one entry", () => {
  const f = fakeDb();
  for (const amt of [1100, 2200, 1100, 2200, 1100]) { f.step([row("a", amt)]); check(f.db, [row("a", amt)]); }
  assert.equal(f.db.entries.length, 1);
});

test("reversal pairs left by earlier versions are cleaned up on the next sync", () => {
  const f = fakeDb();
  f.step([row("a", 1100)]);
  const old = f.db.entries[0];
  // what the old sync left behind: a reversal of the first version and a corrected entry with a suffixed key
  f.db.entries.push({ id: "rev1", date: old.date, kind: "reversal", reverses: old.id, source: "migrated", status: "posted", lines: old.lines.map((l) => ({ ...l, dr: l.cr, cr: l.dr })) });
  f.db.map.push({ legacy_id: "rev:" + old.id, journal_entry_id: "rev1" });
  const cur = Sync.plan([row("a", 3300)], {}, { entries: [], map: [] }, deps).target.entries[0];
  f.db.entries.push({ ...cur, id: "c1", status: "posted" });
  f.db.map.push({ legacy_id: "a#x.1", journal_entry_id: "c1" });
  const p = f.step([row("a", 3300)]);
  assert.equal(p.counts.changed, 1);
  assert.equal(f.db.entries.length, 1);
  assert.ok(f.db.entries.every((e) => e.kind !== "reversal"));
  assert.deepEqual(f.db.map.map((m) => m.legacy_id), ["a"]);
  check(f.db, [row("a", 3300)]);
  assert.equal(f.step([row("a", 3300)]).counts.unchanged, 1);
});

test("a deleted row disappears from the journal: no reversal, nothing left", () => {
  const f = fakeDb();
  f.step([row("a", 1100), row("b", 2200)]);
  assert.deepEqual(f.step([row("b", 2200)]).counts, { added: 0, changed: 0, removed: 1, unchanged: 1 });
  assert.equal(f.db.entries.length, 1);
  assert.ok(f.db.entries.every((e) => e.kind !== "reversal"));
  check(f.db, [row("b", 2200)]);
});

test("a row edited and then deleted: nothing of it is left", () => {
  const f = fakeDb();
  f.step([row("a", 1100), row("b", 2200)]);
  f.step([row("a", 3300), row("b", 2200)]);
  assert.equal(f.db.entries.length, 2);
  f.step([row("b", 2200)]);
  assert.deepEqual(f.db.entries.map((e) => e.legacy_ids[0]), ["b"]);
  assert.equal(f.db.map.length, 1);
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
