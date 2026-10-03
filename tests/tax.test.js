// Tax engine (tax/income.js, consumption.js, calendar.js): figures checked by hand against the NTA rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const I = load("tax/income.js"), C = load("tax/consumption.js"), K = load("tax/calendar.js");

test("基礎控除 by year (令和7年分 / 令和8年分)", () => {
  assert.equal(I.basicDeduction(4000000, 2026), 1040000);
  assert.equal(I.basicDeduction(5000000, 2026), 670000);
  assert.equal(I.basicDeduction(7000000, 2026), 620000);
  assert.equal(I.basicDeduction(1000000, 2025), 950000);
  assert.equal(I.basicDeduction(3000000, 2025), 880000);
  assert.equal(I.basicDeduction(30000000, 2026), 0);
});

test("income tax: 事業所得 400万円, 青色65万, 国民年金+国保 40万円 (令和8年分)", () => {
  const r = I.compute({ year: 2026, businessIncome: 4000000, blueDeduction: 650000, socialInsurance: 400000 });
  // 合計所得 3,350,000 → 基礎控除 1,040,000; 課税所得 3,350,000 − 400,000 − 1,040,000 = 1,910,000 → ×5% = 95,500; 復興 2,005
  assert.equal(r.totalIncome, 3350000);
  assert.equal(r.taxableIncome, 1910000);
  assert.equal(r.incomeTax, 95500);
  assert.equal(r.reconstruction, 2005);
  assert.equal(r.due, 97500);   // 97,505 → 百円未満切捨て
});

test("withholding on fees larger than the tax → refund", () => {
  const r = I.compute({ year: 2026, businessIncome: 3000000, blueDeduction: 650000, socialInsurance: 300000, withheld: 306300 });
  assert.ok(r.due < 0);
  assert.equal(r.refund, -r.due);
});

test("deductions: life insurance formula, medical threshold, donations, spouse", () => {
  assert.equal(I.lifeInsurance(30000), 25000);
  assert.equal(I.lifeInsurance(100000), 40000);
  const r = I.compute({ year: 2026, businessIncome: 6000000, blueDeduction: 650000, medicalPaid: 150000, donations: 30000, spouse: true });
  assert.equal(r.deductions.medical, 50000);       // 150,000 − min(10万, 5% of 5,350,000)
  assert.equal(r.deductions.donation, 28000);
  assert.equal(r.deductions.spouse, 380000);
  assert.ok(r.furusatoLimit > 2000);
});

test("business tax: (所得 − 290万円) × 5%, before the blue deduction", () => {
  assert.equal(I.compute({ year: 2026, businessIncome: 5000000, blueDeduction: 650000 }).businessTax, 105000);
  assert.equal(I.compute({ year: 2026, businessIncome: 2000000, blueDeduction: 650000 }).businessTax, 0);
});

test("consumption tax: 課税売上 550万 (10%), 課税仕入 110万 (適格) — 本則 vs 2割特例 vs 簡易 (第5種)", () => {
  const a = { sales10: 5500000, sales8: 0, salesOther: 0, q10: 1100000, q8: 0, n10: 0, n8: 0, credit10: 1100000, credit8: 0 };
  const r = C.compute(a, { year: 2026, kind: 5, niwariEligible: true, simpleElected: false });
  assert.equal(r.base, 5000000);
  assert.equal(r.outTax, 390000);
  const g = r.methods.find((m) => m.key === "general"), n = r.methods.find((m) => m.key === "niwari"), s = r.methods.find((m) => m.key === "simple");
  assert.equal(g.credit, 78000);
  assert.equal(g.national, 312000);
  assert.equal(g.local, 88000);       // 312,000 × 22/78 = 88,000
  assert.equal(n.national, 78000);    // 390,000 × 20%
  assert.equal(n.local, 22000);
  assert.equal(s.national, 195000);   // 390,000 × (1 − 50%)
  assert.equal(s.available, false, "簡易課税 needs the 届出 in advance");
  assert.equal(r.best, "niwari");
  assert.equal(r.saving, 400000 - 100000);
});

test("2027–2028: 3割特例 instead of 2割", () => {
  const r = C.compute({ sales10: 1100000, sales8: 0, credit10: 0, credit8: 0 }, { year: 2027, niwariEligible: true });
  assert.ok(r.methods.some((m) => m.key === "sanwari"));
});

test("aggregate: business share, qualified vs transitional credit (80% → 50% from 2026-10-01), fixed assets", () => {
  const rows = [
    { type: "income", date: "2026-05-01", amt10: 110000, amt8: 0, amt0: 0 },
    { type: "expense", date: "2026-05-02", amt10: 11000, amt8: 0, amt0: 0, bizRatio: 50, q: true },
    { type: "expense", date: "2026-09-02", amt10: 1100, amt8: 0, amt0: 0, q: false },
    { type: "expense", date: "2026-10-02", amt10: 1100, amt8: 0, amt0: 0, q: false },
    { type: "expense", date: "2025-12-31", amt10: 99999, amt8: 0, amt0: 0, q: true },
  ];
  const a = C.aggregate(rows, 2026, { qualOK: (e) => e.q, ratioOf: (e) => (e.bizRatio ?? 100) / 100, transitionalRate: (d) => (d < "2026-10-01" ? 0.8 : 0.5),
    assets: [{ date: "2026-04", cost: 220000, ratio: 80 }] });
  assert.equal(a.sales10, 110000);
  assert.equal(a.q10, 5500 + 176000);
  assert.equal(a.credit10, 5500 + 880 + 550 + 176000);
  assert.equal(a.nonQualifiedCount, 2);
});

test("deadlines: weekend moves to Monday; 令和8年分 dates", () => {
  assert.equal(K.due(2027, 3, 15), "2027-03-15");
  assert.equal(K.due(2026, 1, 31), "2026-02-02");   // Saturday → Monday
  const ds = K.forYear(2026, { ctax: "general", prepay: true });
  assert.ok(ds.some((d) => d.key === "dlConsumptionTax" && d.date === "2027-03-31"));
  assert.ok(ds.some((d) => d.key === "dlPrepay1"));
  const up = K.upcoming("2026-10-03", { ctax: "general" });
  assert.equal(up[0].key, "dlSimpleElect");
  assert.ok(up.every((u) => u.days >= 0));
});
