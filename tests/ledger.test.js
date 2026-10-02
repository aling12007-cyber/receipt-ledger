// Ledger Engine (engine/ledger.js): trial balance, general ledger, P&L — computed only from posted journal entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES } from "./golden/cases.js";
import { load } from "./helpers/load.js";

const Ledger = load("engine/ledger.js");
// Golden lines use tax/taxAmount; the books use tax_code/tax_amount
const toBooks = (entries) => entries.map((e, i) => ({ id: "g" + i, status: "posted", ...e, lines: e.lines.map((l) => ({ account: l.account, dr: l.dr, cr: l.cr, tax_code: l.tax, tax_amount: l.taxAmount })) }));
const year = toBooks(CASES.find((c) => c.id === "28").journal);
const carry = toBooks(CASES.find((c) => c.id === "26").journal);

test("trial balance balances and matches the Golden figures (case 28)", () => {
  const tb = Ledger.trialBalance(year, { from: "2026-01-01", to: "2026-12-31" });
  assert.ok(tb.balanced);
  assert.equal(tb.totals.dr, tb.totals.cr);
  const bal = Object.fromEntries(tb.rows.map((r) => [r.account, r.balance]));
  assert.equal(bal["売上高"], 3300000);
  assert.equal(bal["減価償却費"], 66000);
  assert.equal(bal["工具器具備品"], 440000 - 82500);
  assert.equal(bal["事業主貸"], 720000 + 16500);
});

test("P&L from the journal equals the 決算書 income of case 28", () => {
  const pl = Ledger.profitLoss(year, { from: "2026-01-01", to: "2026-12-31" });
  const want = CASES.find((c) => c.id === "28").expect.filing;
  assert.deepEqual([pl.sales, pl.expenses, pl.income], [want.sales, want.expenses, want.income]);
  for (const [a, v] of Object.entries(want.rows)) assert.equal(pl.by[a], v, a);
  assert.ok(Ledger.depreciationPosted(year, 2026));
});

test("opening entries are 期首残高, not movements (case 26)", () => {
  const tb = Ledger.trialBalance(carry, { from: "2026-01-01", to: "2026-12-31" });
  const bank = tb.rows.find((r) => r.account === "普通預金");
  assert.deepEqual([bank.opening, bank.dr, bank.cr, bank.closing], [500000, 1100000, 530000, 1070000]);
  assert.equal(tb.rows.find((r) => r.account === "元入金").balance, 600000);
  assert.ok(tb.balanced);
});

test("general ledger: running balance on the normal side, other accounts, 諸口", () => {
  const gl = Ledger.generalLedger(carry, "普通預金", { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(gl.opening, 500000);
  assert.deepEqual(gl.rows.map((r) => [r.counter, r.dr, r.cr, r.balance]), [
    ["売上高", 1100000, 0, 1600000], ["外注工賃", 0, 330000, 1270000], ["事業主貸", 0, 200000, 1070000]]);
  assert.equal(gl.closing, 1070000);
  const sales = Ledger.generalLedger(carry, "売上高");
  assert.equal(sales.normal, "cr");
  assert.equal(sales.closing, 1100000);
  const multi = Ledger.generalLedger(toBooks(CASES.find((c) => c.id === "04").journal), "現金");
  assert.equal(multi.rows[0].counter, "諸口");                // one credit against four debit accounts
});

test("a period shows earlier movements as the opening balance", () => {
  const tb = Ledger.trialBalance(carry, { from: "2026-06-01", to: "2026-12-31" });
  assert.equal(tb.rows.find((r) => r.account === "普通預金").opening, 500000);
  const sep = Ledger.trialBalance(year, { from: "2026-04-01", to: "2026-04-30" });
  assert.equal(sep.rows.find((r) => r.account === "工具器具備品").dr, 440000);
  assert.ok(sep.balanced);
});

test("drafts and void entries never count; reversals cancel", () => {
  const e = { date: "2026-03-01", lines: [{ account: "消耗品費", dr: 1100, cr: 0 }, { account: "現金", dr: 0, cr: 1100 }] };
  const rev = { ...e, kind: "reversal", status: "posted", lines: e.lines.map((l) => ({ ...l, dr: l.cr, cr: l.dr })) };
  assert.equal(Ledger.profitLoss([{ ...e, status: "draft" }, { ...e, status: "void" }]).expenses, 0);
  assert.equal(Ledger.profitLoss([{ ...e, status: "posted" }, rev]).expenses, 0);
});

test("monthly figures and 地代家賃の内訳 (rent incl. the private share)", () => {
  const m = Ledger.monthly(year, 2026);
  assert.equal(m[11].sales, 3300000);
  assert.equal(m[11].expenses, 480000 + 132000 + 88000 + 33000 + 66000);
  const rent = Ledger.rentByPayee(toBooks([{ date: "2026-04-27", vendor: "大家さん", lines: CASES.find((c) => c.id === "09").journal[0].lines }]), 2026);
  assert.deepEqual(rent, [{ payee: "大家さん", total: 100000, business: 40000, n: 1 }]);
});
