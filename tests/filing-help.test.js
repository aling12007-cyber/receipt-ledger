// e-Tax transcription sheet, pre-filing check, loss carry-forward, calendar file, more statement layouts. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const E = load("tax/etax.js"), P = load("engine/precheck.js"), IT = load("tax/income.js"), C = load("tax/calendar.js"), K = load("engine/bank-import.js"), F = load("filing.js");
const totalOf = (e) => (+e.amt10 || 0) + (+e.amt8 || 0) + (+e.amt0 || 0);
const bizOf = (e) => Math.round(totalOf(e) * ((e.bizRatio ?? 100) / 100));
const ex = (id, date, amt, extra = {}) => ({ id, type: "expense", date, vendor: "テスト商店", amt10: amt, amt8: 0, amt0: 0, debit: "消耗品費", credit: "事業主借", bizRatio: 100, assetId: "x.jpg", ...extra });

test("e-Tax sheet follows the 作成コーナー order and lists only non-zero expenses", () => {
  const entries = [{ id: "s", type: "income", date: "2026-03-01", amt10: 550000, amt8: 0, amt0: 0 }, ex("a", "2026-04-01", 11000, { debit: "通信費" }), ex("b", "2026-05-01", 3300, { debit: "会議費" })];
  const pl = F.profitLoss({ entries, year: 2026, totalOf, bizOf, deduction: 650000 });
  const sh = E.sheets({ blue: true, pl, monthly: F.monthly({ entries, year: 2026, totalOf, bizOf }), rent: [], dep: [], needBS: false }, "ja");
  assert.deepEqual(sh.map((s) => s.key), ["monthly", "pl", "result"]);
  const labels = sh[1].items.map((i) => i.label);
  assert.ok(labels[0].startsWith("① 売上"));
  assert.ok(labels.some((l) => /通信費/.test(l)) && labels.some((l) => /会議費（科目名も入力）/.test(l)));
  assert.ok(!labels.some((l) => /租税公課/.test(l)));
  assert.equal(sh[0].items.find((i) => i.label === "3月 売上（収入）金額").value, 550000);
  assert.match(E.toText(sh), /■ 損益計算書/);
});

test("pre-filing check: errors first, duplicates, missing vendor, home-office share", () => {
  const entries = [ex("a", "2026-04-01", 5000), ex("b", "2026-04-01", 5000), ex("c", "2026-05-01", 1000, { vendor: "" }), ex("d", "2026-06-01", 8000, { debit: "通信費" }), ex("e", "2099-01-01", 1)];
  const out = P.run({ entries, year: 2026, today: "2026-10-03", totalOf, needBS: true, bs: { closeEntered: false, diff: 0 }, deductionsEntered: true, bigItems: [] });
  const codes = out.map((x) => x.code);
  assert.equal(out[0].level, "error");
  assert.ok(codes.includes("bsClose") && codes.includes("noSales") && codes.includes("duplicates") && codes.includes("noVendor") && codes.includes("fullBiz"));
  assert.deepEqual(out.find((x) => x.code === "duplicates").ids.sort(), ["a", "b"]);
  assert.ok(!codes.includes("future"));   // 2099 is another year
});

test("loss: set off against salary, carried forward with blue, used the next year", () => {
  const r = IT.compute({ year: 2026, businessIncome: -800000, blueDeduction: 0, blue: true, salaryIncome: 300000 });
  assert.equal(r.totalIncome, 0);
  assert.equal(r.lossThisYear, 500000);
  assert.equal(r.incomeTax, 0);
  const n = IT.compute({ year: 2027, businessIncome: 3000000, blueDeduction: 650000, lossCarried: 500000 });
  const plain = IT.compute({ year: 2027, businessIncome: 3000000, blueDeduction: 650000 });
  assert.equal(n.lossUsed, 500000);
  assert.equal(n.taxableIncome, plain.taxableIncome - 500000);
  assert.ok(n.incomeTax < plain.incomeTax);
  assert.equal(IT.compute({ year: 2026, businessIncome: -100000, blueDeduction: 0, blue: false }).lossThisYear, 0);
});

test("calendar file: all-day events with two reminders, lines folded by bytes", () => {
  const ics = C.toICS([{ uid: "a", date: "2027-03-15", title: "所得税の確定申告・納付（2026年分）とても長いタイトルの確認用テキストです" }], "2026-10-03T00:00:00.000Z");
  assert.match(ics, /DTSTART;VALUE=DATE:20270315\r\nDTEND;VALUE=DATE:20270316/);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
  for (const l of ics.split("\r\n")) assert.ok(new TextEncoder().encode(l).length <= 75, l);
});

test("statement layouts: signed 入出金 column, 受入/払出, 支払い/預かり, (円) suffixes", () => {
  const a = K.parseCSV("取引日,入出金(円),取引後残高(円),入出金内容\n20260901,-1100,98900,テスト電力\n20260905,55000,153900,振込 テスト\n");
  assert.deepEqual(K.toTransactions(a, K.detect(a), "bank").map((t) => [t.out, t.in]), [[1100, 0], [0, 55000]]);
  const b = K.parseCSV("取引日,受入金額（円）,払出金額（円）,詳細１\n2026/09/01,,2200,テスト\n");
  assert.deepEqual(K.toTransactions(b, K.detect(b), "bank").map((t) => [t.out, t.in, t.desc]), [[2200, 0, "テスト"]]);
  const c = K.parseCSV("日付,摘要,摘要内容,支払い金額,預かり金額,差引残高\n2026/9/2,カード,テスト,880,,1000\n");
  assert.equal(K.toTransactions(c, K.detect(c), "bank")[0].out, 880);
});
