// Golden Test Cases (P0 safety net).
// 1. Each case is checked for internal consistency: balanced entries, tax amounts, trial balance, filing figures.
//    The small reference functions here are the spec the real engines must match.
// 2. Today's app (books.js + filing.js) is run against every case it can express.
// 3. What today's app cannot do yet is reported as "todo" with the reason, until the engines land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, CHART, TAX } from "./golden/cases.js";
import { load } from "./helpers/load.js";

const Books = load("books.js");
const Filing = load("filing.js");

const PURCHASE = new Set(["P10", "P8"]);
const RATE = { P10: 10, P8: 8, S10: 10, S8: 8 };
const DEDUCTION = { blue65: 650000, blue55: 550000, blue10: 100000, white: 0 };
const settingsOf = (c) => ({ filing: "blue65", ...(c.settings || {}) });

// net balance per account (debit positive)
function trialBalance(entries) {
  const tb = {};
  for (const e of entries) for (const l of e.lines) tb[l.account] = (tb[l.account] || 0) + l.dr - l.cr;
  return tb;
}
function pickTB(tb, keys) { return Object.fromEntries(keys.map((k) => [k, tb[k] || 0])); }

// creditable input tax (本則課税, 税込経理): invoice transitional rates for entries without a qualified invoice
function creditable(entries) {
  let sum = 0;
  for (const e of entries) {
    const rate = e.qualified === false ? Books.transitionalRate(e.date) : 1;
    for (const l of e.lines) if (PURCHASE.has(l.tax)) sum += Math.floor((l.dr ? 1 : -1) * l.taxAmount * rate);
  }
  return sum;
}

// P&L from the journal (税込経理): revenue − expenses
function profit(entries) {
  const tb = trialBalance(entries);
  let sales = 0, expenses = 0;
  const rows = {};
  for (const [a, v] of Object.entries(tb)) {
    if (CHART[a] === "revenue") sales += -v;
    if (CHART[a] === "expense") { expenses += v; rows[a] = v; }
  }
  return { sales, expenses, income: sales - expenses, rows };
}

for (const c of CASES) {
  test(`case ${c.id} ${c.title} — the case is consistent`, () => {
    for (const [i, e] of c.journal.entries()) {
      const dr = e.lines.reduce((s, l) => s + l.dr, 0), cr = e.lines.reduce((s, l) => s + l.cr, 0);
      assert.equal(dr, cr, `entry ${i} is not balanced`);
      for (const l of e.lines) {
        assert.ok(CHART[l.account], `unknown account ${l.account}`);
        assert.ok(TAX[l.tax], `unknown tax code ${l.tax}`);
        assert.ok((l.dr > 0) !== (l.cr > 0), `line ${l.account} must be debit or credit`);
        const gross = l.dr || l.cr;
        const want = RATE[l.tax] ? Math.floor(gross * RATE[l.tax] / (100 + RATE[l.tax])) : 0;
        assert.equal(l.taxAmount, want, `tax amount of ${l.account} ${gross}`);
        if (CHART[l.account] !== "expense" && CHART[l.account] !== "revenue" && l.account !== "工具器具備品") assert.equal(l.tax, "-", `${l.account} carries no tax code`);
      }
    }
    const ex = c.expect || {};
    if (ex.trialBalance) assert.deepEqual(pickTB(trialBalance(c.journal), Object.keys(ex.trialBalance)), ex.trialBalance);
    if (ex.ctax) assert.equal(creditable(c.journal), ex.ctax.creditable);
    if (ex.income != null) assert.equal(profit(c.journal).income, ex.income);
    if (ex.depreciation) {
      const dep = c.journal.find((e) => e.kind === "closing");
      assert.equal(dep.lines.find((l) => l.account === "工具器具備品").cr, ex.depreciation.dep);
      assert.equal(dep.lines.find((l) => l.account === "減価償却費").dr, ex.depreciation.business);
    }
    if (ex.filing) {
      const p = profit(c.journal), ded = Math.min(DEDUCTION[settingsOf(c).filing], Math.max(0, p.income));
      assert.equal(p.sales, ex.filing.sales);
      assert.equal(p.expenses, ex.filing.expenses);
      assert.equal(p.income, ex.filing.income);
      assert.equal(ded, ex.filing.deduction);
      assert.equal(p.income - ded, ex.filing.taxable);
      for (const [a, v] of Object.entries(ex.filing.rows || {})) assert.equal(p.rows[a], v, a);
    }
    if (ex.taxReturn) {
      const p = profit(c.journal), ded = Math.min(DEDUCTION[settingsOf(c).filing], p.income);
      assert.deepEqual(Object.values(ex.taxReturn), [p.sales, p.income - ded]);
    }
    if (ex.nextOpening) {
      // closing balances of assets and liabilities carry over; 元入金 absorbs income and owner movements
      const tb = trialBalance(c.journal);
      const carry = Object.entries(tb).filter(([a, v]) => v && ["asset", "liability"].includes(CHART[a]));
      const motoire = -(tb["元入金"] || 0) + ex.income + -(tb["事業主借"] || 0) - (tb["事業主貸"] || 0);
      const lines = [...carry.map(([a, v]) => ({ account: a, dr: Math.max(v, 0), cr: Math.max(-v, 0) })), { account: "元入金", dr: 0, cr: motoire }];
      assert.deepEqual(lines, ex.nextOpening.lines.map(({ account, dr, cr }) => ({ account, dr, cr })));
    }
  });

  // ---- today's app ----
  if (c.legacy) {
    test(`case ${c.id} — today's app records the same amounts`, () => {
      const covered = (c.legacy.covers || c.journal.map((_, i) => i)).map((i) => c.journal[i]);
      const want = trialBalance(covered);
      const got = {};
      for (const e of c.legacy.entries) for (const l of Books.linesOf(e)) { got[l.dr] = (got[l.dr] || 0) + l.amt; got[l.cr] = (got[l.cr] || 0) - l.amt; }
      const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((k) => want[k] || got[k]);
      assert.deepEqual(pickTB(got, keys), pickTB(want, keys));
    });
  }
  const ex = c.expect || {};
  if (c.legacy && ex.depreciation) {
    test(`case ${c.id} — today's depreciation calculation`, () => {
      const d = Filing.depreciation(c.legacy.assets, 2026);
      assert.equal(d.dep, ex.depreciation.dep);
      assert.equal(d.business, ex.depreciation.business);
      assert.equal(d.private, ex.depreciation.private);
      assert.equal(d.close, ex.depreciation.close);
    });
  }
  if (c.legacy && ex.legacyBases) {
    test(`case ${c.id} — today's input-tax table (インボイス経過措置)`, () => {
      const b = Books.inputTaxBases(c.legacy.entries, 2026, (e) => /^T\d{13}$/.test(e.invoiceNo || ""));
      for (const [k, v] of Object.entries(ex.legacyBases)) assert.equal(b[k], v, k);
    });
  }
  if (c.legacy && ex.filing) {
    test(`case ${c.id} — today's 決算書 page 1`, () => {
      const dep = Filing.depreciation(c.legacy.assets || [], 2026);
      const pl = Filing.profitLoss({ entries: c.legacy.entries, year: 2026, totalOf: Books.totalOf, bizOf: Books.bizOf, depBusiness: dep.business, deduction: DEDUCTION[settingsOf(c).filing] });
      assert.equal(pl.sales, ex.filing.sales);
      assert.equal(pl.expenses, ex.filing.expenses);
      assert.equal(pl.income, ex.filing.income);
      assert.equal(pl.deduction, ex.filing.deduction);
      assert.equal(pl.taxable, ex.filing.taxable);
      for (const [a, v] of Object.entries(ex.filing.rows || {})) assert.equal(pl.rows.find((r) => r.name === a)?.v, v, a);
    });
  }
  if (c.legacy && ex.knownBug) {
    test(`case ${c.id} — known: Dashboard income today`, () => {
      assert.equal(Books.yearTotals(c.legacy.entries, 2026).income, ex.knownBug.dashboardIncome);
    });
    test(`case ${c.id} — Dashboard income equals 決算書 income`, { todo: "P3: Dashboard reads the trial balance — " + ex.knownBug.why }, () => {
      assert.equal(Books.yearTotals(c.legacy.entries, 2026).income, ex.filing.income);
    });
  }

  // ---- what the engines must add ----
  if (c.gap) test(`case ${c.id} — engine`, { todo: c.gap }, () => {});
}
