// Journal Engine (engine/journal.js), account master and tax rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CASES, CHART } from "./golden/cases.js";
import { load } from "./helpers/load.js";

const Journal = load("engine/journal.js");
const Accounts = load("engine/accounts.js");
const TaxRules = load("engine/tax-rules.js");
const OCR = load("ocr.js");
const hints = { guess: (v, t) => OCR.guessAccount(v + " " + t, t) };

const key = (l) => [l.account, l.dr, l.cr, l.tax_code ?? l.tax, l.tax_amount ?? l.taxAmount].join("|");
const bag = (entries) => entries.flatMap((e) => e.lines.map(key)).sort();
const golden = (id, i = 0) => CASES.find((c) => c.id === id).journal[i];

test("account master equals the database seed and covers the Golden chart", () => {
  const sql = fs.readFileSync(new URL("../supabase/002_accounting_core.sql", import.meta.url), "utf8");
  const seed = [...sql.matchAll(/\('([^']+)','(asset|liability|equity|revenue|expense)',(null|'[^']*'),'([^']+)',(\d+)\)/g)]
    .map(([, name, type, line, tax, sort]) => [name, type, line === "null" ? null : line.slice(1, -1), tax, +sort]);
  assert.deepEqual(Accounts.MASTER.map((a) => [a.name, a.type, a.filingLine, a.defaultTax, a.sort]), seed);
  for (const [name, type] of Object.entries(CHART)) assert.equal(Accounts.typeOf(name), type, name);
});

// 取引登録 → the same journal lines as the Golden cases
const QUICK = [
  ["01", { date: "2026-01-10", vendor: "文具店", amount: 3300, description: "ボールペン", payment: "cash", invoiceNo: "T1234567890123" }],
  ["02", { date: "2026-01-15", amount: 5500, account: "消耗品費", payment: "card" }],
  ["02", { type: "settle", date: "2026-02-27", amount: 5500, to: "未払金", from: "普通預金" }, 1],
  ["03", { date: "2026-02-03", vendor: "Amazon", amount: 4400, description: "USBハブ", payment: "card", invoiceNo: "T6040001084325" }],
  ["05", { date: "2026-03-05", amount: 2200, account: "会議費", payment: "cash" }],
  ["06", { date: "2026-03-06", amount: 1320, account: "旅費交通費", payment: "cash" }],
  ["07", { date: "2026-09-01", amount: 11000, account: "通信費", payment: "cash" }],
  ["08", { date: "2026-04-25", amount: 110000, account: "地代家賃", payment: "bank" }],
  ["09", { date: "2026-04-27", amount: 100000, account: "地代家賃", payment: "bank", bizRatio: 40 }],
  ["10", { date: "2026-05-26", amount: 8800, account: "通信費", payment: "bank", bizRatio: 60 }],
  ["11", { date: "2026-04-01", amount: 440000, description: "MacBook Pro", payment: "bank" }],
  ["13", { type: "sale", date: "2026-05-10", amount: 55000, payment: "cash" }],
  ["14", { type: "sale", date: "2026-05-31", amount: 330000, payment: "receivable" }],
  ["15", { type: "collect", date: "2026-06-30", amount: 330000, fee: 660 }, 1],
  ["16", { date: "2026-06-02", amount: 2750, account: "新聞図書費", payment: "private" }],
  ["17", { type: "transfer", date: "2026-06-25", amount: 50000, from: "普通預金", to: "事業主貸" }],
  ["18", { date: "2026-07-01", amount: 4320, account: "新聞図書費", taxRate: 8, payment: "cash" }],
  ["19", { date: "2026-07-10", amount: 22000, account: "広告宣伝費", payment: "card", invoiceNo: "T1111111111111" }],
  ["20", { date: "2026-07-15", amount: 24000, account: "損害保険料", payment: "bank" }],
  ["21", { date: "2026-08-31", amount: 30000, account: "租税公課", payment: "bank" }],
  ["22", { date: "2026-09-15", amount: 55000, account: "外注工賃", payment: "bank", invoiceNo: "T2222222222222" }],
];
for (const [id, q, i] of QUICK) {
  test(`取引登録 → Golden case ${id}${i ? " entry " + (i + 1) : ""}`, () => {
    const { entry } = Journal.fromQuickEntry(q, hints);
    assert.deepEqual(bag([entry]), bag([golden(id, i || 0)]));
    assert.ok(Journal.validate(entry).ok, JSON.stringify(Journal.validate(entry).errors));
  });
}

test("every Golden journal entry passes validation with no tax warnings", () => {
  for (const c of CASES) for (const e of c.journal) {
    const lines = e.lines.map((l) => ({ account: l.account, dr: l.dr, cr: l.cr, tax_code: l.tax, tax_amount: l.taxAmount }));
    const v = Journal.validate({ ...e, lines });
    assert.ok(v.ok, `case ${c.id}: ${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.warnings.filter((w) => w.code === "TAX_AMOUNT"), [], `case ${c.id}`);
  }
});

test("validation blocks what the database would refuse", () => {
  const e = { date: "2026-01-01", kind: "normal", vendor: "", invoice_no: "", memo: "", lines: [
    { account: "消耗品費", dr: 1000, cr: 0, tax_code: "P10", tax_amount: 90 }, { account: "現金", dr: 0, cr: 900, tax_code: "-", tax_amount: 0 }] };
  assert.deepEqual(Journal.validate(e).errors.map((x) => x.code), ["UNBALANCED"]);
  const bad = { ...e, lines: [{ account: "謎の科目", dr: 100, cr: 100, tax_code: "X", tax_amount: 0 }] };
  assert.deepEqual(Journal.validate(bad).errors.map((x) => x.code).sort(), ["LINE_SIDE", "TAX_CODE", "TOO_FEW_LINES", "UNKNOWN_ACCOUNT"]);
  const ok = { ...e, lines: [e.lines[0], { ...e.lines[1], cr: 1000 }] };
  assert.deepEqual(Journal.validate(ok, { yearLocked: (y) => y === 2026 }).errors.map((x) => x.code), ["YEAR_LOCKED"]);
});

test("reversal cancels an entry; correction keeps the original and adds reversal + fixed entry", () => {
  const { entry } = Journal.fromQuickEntry({ date: "2026-03-01", amount: 8800, account: "通信費", payment: "bank", bizRatio: 60 });
  const posted = { ...entry, id: "e1" };
  const rev = Journal.reverse(posted);
  assert.equal(rev.kind, "reversal");
  assert.equal(rev.reverses, "e1");
  assert.ok(Journal.validate(rev).ok);
  assert.ok(Object.values(Journal.balances([posted, rev])).every((v) => v === 0));
  const fixed = Journal.fromQuickEntry({ date: "2026-03-01", amount: 8800, account: "通信費", payment: "bank", bizRatio: 50 }).entry;
  const [r, f] = Journal.correct(posted, fixed);
  assert.deepEqual(Journal.balances([posted, r, f]), Journal.balances([fixed]));
});

test("suggestions: shop and item rules, fixed-asset candidates, 家事按分, learned vendors", () => {
  const acc = (q) => Journal.fromQuickEntry({ date: "2026-10-05", payment: "card", ...q }, hints).suggestions[0].value;
  assert.equal(acc({ vendor: "スターバックス", amount: 1100 }), "会議費");
  assert.equal(acc({ vendor: "JR東日本", amount: 1320 }), "旅費交通費");
  assert.equal(acc({ vendor: "Amazon", amount: 12800, description: "仕事用モニター" }), "消耗品費");   // under ¥100,000: expensed
  const big = Journal.fromQuickEntry({ date: "2026-10-05", vendor: "Amazon", amount: 128000, description: "仕事用モニター", payment: "card" }, hints);
  assert.equal(big.suggestions[0].value, "工具器具備品");
  assert.ok(big.notes.includes("fixedAssetSmall"));                                               // blue return, under ¥400,000 (2026-04〜)
  const white = Journal.fromQuickEntry({ date: "2026-10-05", amount: 150000, description: "パソコン", payment: "card", blue: false }, hints);
  assert.ok(white.notes.includes("fixedAssetLump"));
  assert.ok(Journal.fromQuickEntry({ date: "2026-10-05", amount: 8800, account: "通信費", payment: "bank" }).notes.includes("allocation"));
  const learned = Journal.fromQuickEntry({ date: "2026-10-05", vendor: "Amazon", amount: 3000, payment: "card" }, { ...hints, learned: (v) => (v === "Amazon" ? "新聞図書費" : null) });
  assert.deepEqual([learned.suggestions[0].value, learned.suggestions[0].reason], ["新聞図書費", "過去の修正（同じ取引先）"]);
});

test("tax rules are versioned and sourced", () => {
  assert.equal(TaxRules.rulesFor("2026-05-01").id, "2026.1");
  assert.deepEqual(["2026-09-30", "2026-10-01", "2029-09-30", "2029-10-01"].map(TaxRules.transitionalRate), [0.8, 0.5, 0.5, 0]);
  assert.deepEqual([99999, 100000, 199999, 350000, 399999, 400000].map((a) => TaxRules.assetClass(a, "2026-10-01", true)), ["expense", "small", "small", "small", "small", "depreciate"]);
  assert.equal(TaxRules.assetClass(350000, "2026-03-31", true), "depreciate");                     // before 2026-04: limit ¥300,000
  assert.deepEqual([150000, 250000].map((a) => TaxRules.assetClass(a, "2026-10-01", false)), ["lump", "depreciate"]);
  for (const v of TaxRules.VERSIONS) assert.ok(v.sources.length && v.sources.every((s) => /^https:\/\/www\.nta\.go\.jp\//.test(s.url)), v.id);
});
