// Data upgrade (engine/migrate.js): old rows → journal entries that match the Golden cases line for line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES } from "./golden/cases.js";
import { load } from "./helpers/load.js";

const Books = load("books.js");
const Filing = load("filing.js");
const Migrate = load("engine/migrate.js");
let n = 0;
const deps = { Books, Filing, uuid: () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0") };

// order-free comparison of journal lines
const key = (l) => [l.account, l.dr, l.cr, l.tax_code ?? l.tax, l.tax_amount ?? l.taxAmount].join("|");
const bag = (entries) => entries.flatMap((e) => e.lines.map(key)).sort();
const isAcquisition = (e) => e.lines.some((l) => l.account === "工具器具備品" && l.dr > 0);

for (const c of CASES.filter((c) => c.legacy)) {
  test(`case ${c.id} ${c.title} — upgraded journal matches the Golden entries`, () => {
    const p = Migrate.plan(c.legacy.entries, { assets: c.legacy.assets || [] }, deps);
    const covers = c.legacy.covers || c.journal.map((_, i) => i);
    const want = c.journal.filter((e, i) => covers.includes(i) || isAcquisition(e));
    assert.deepEqual(bag(p.entries), bag(want));
    const v = Migrate.verify(c.legacy.entries, p, deps);
    assert.ok(v.ok, JSON.stringify(v.diffs));
  });
}

test("split lines of one receipt become one compound entry", () => {
  const c = CASES.find((c) => c.id === "04");
  const p = Migrate.plan(c.legacy.entries, {}, deps);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].kind, "compound");
  assert.equal(p.entries[0].legacy_ids.length, 4);
  assert.equal(p.documents.length, 1);
  assert.equal(p.entries[0].transaction.document_path, "r04");
});

test("invoice status: registration number → 確認済, none → 要確認, sales → none", () => {
  const p = Migrate.plan([
    { id: "a", type: "expense", date: "2026-01-01", debit: "消耗品費", credit: "現金", amt10: 1100, amt8: 0, amt0: 0, invoiceNo: "T1234567890123" },
    { id: "b", type: "expense", date: "2026-01-01", debit: "消耗品費", credit: "現金", amt10: 1100, amt8: 0, amt0: 0 },
    { id: "c", type: "income", date: "2026-01-01", debit: "普通預金", amt10: 1100, amt8: 0, amt0: 0 },
  ], {}, deps);
  assert.deepEqual(p.entries.map((e) => e.invoice_status), ["確認済", "要確認", null]);
});

test("opening balances become an opening entry with 元入金 (Golden case 26)", () => {
  const c = CASES.find((c) => c.id === "26");
  const p = Migrate.plan([], { bs: { 2026: { open: { cash: 100000, bank: 500000 } } } }, deps);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].kind, "opening");
  assert.deepEqual(bag(p.entries), bag([c.journal[0]]));
  assert.deepEqual(p.fiscal_years.map((y) => y.year), [2026]);
});

test("an asset bought before the first opening year is in the opening entry at book value, not acquired again", () => {
  const asset = { id: "old", name: "PC", date: "2024-07", cost: 200000, life: 4, method: "sl", ratio: 100, cat: "工具器具備品" };
  const p = Migrate.plan([], { assets: [asset], bs: { 2026: { open: { bank: 100000 } } } }, deps);
  const book = Filing.assetYear(asset, 2026).open;          // 2024: 6 months, 2025: 12 months at 0.25
  assert.equal(book, 200000 - 25000 - 50000);
  assert.equal(p.entries.length, 1);
  assert.deepEqual(p.entries[0].lines.find((l) => l.account === "工具器具備品").dr, book);
  assert.equal(p.entries[0].lines.find((l) => l.account === "元入金").cr, 100000 + book);
  assert.equal(p.fixed_assets.length, 1);
});

test("rounding of the business share never unbalances an entry", () => {
  const rows = [];
  for (let i = 1; i <= 300; i++) rows.push({ id: "r" + i, type: "expense", date: "2026-03-01", debit: "通信費", credit: "普通預金", amt10: 997 + i * 7, amt8: i % 3 ? 0 : 431 + i, amt0: i % 5 ? 0 : 33 * i, bizRatio: (i * 13) % 101 });
  const p = Migrate.plan(rows, {}, deps);
  const v = Migrate.verify(rows, p, deps);
  assert.equal(v.unbalanced, 0);
  assert.ok(v.ok, JSON.stringify(v.diffs.slice(0, 3)));
});

test("settings carry into fiscal years", () => {
  const p = Migrate.plan([{ id: "x", type: "expense", date: "2026-05-01", debit: "消耗品費", credit: "現金", amt10: 110, amt8: 0, amt0: 0 }], { filing: "white", ctax: "general" }, deps);
  assert.deepEqual(p.fiscal_years, [{ year: 2026, filing: "white", ctax_status: "taxable", ctax_method: "general", tax_inclusive: true }]);
});
