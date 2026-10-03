// OCR digit handling (document-intelligence/digits.js): amounts, dates, registration numbers. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const D = load("document-intelligence/digits.js");

test("clean amounts are certain", () => {
  for (const [t, v] of [["¥1,100", 1100], ["1100円", 1100], ["¥11,800-", 11800], ["３，３００", 3300], ["△100", -100]]) {
    const a = D.amount(t);
    assert.equal(a.value, v, t);
    assert.equal(a.ambiguous, false, t);
  }
});

test("OCR lookalikes are fixed and flagged: O→0, I/l→1, S→5, B→8, ¥ read as Y", () => {
  for (const [t, v] of [["11,8OO", 11800], ["1,1O0", 1100], ["l,500", 1500], ["2,S00", 2500], ["1,B00", 1800], ["Y1,100", 1100]]) {
    const a = D.amount(t);
    assert.equal(a.value, v, t);
    assert.equal(a.ambiguous, true, t + " must not look certain");
  }
});

test("a period used as thousands separator (yen has no decimals)", () => {
  const a = D.amount("11.800");
  assert.equal(a.value, 11800);
  assert.ok(a.corrected.includes("period→comma"));
});

test("a comma in the wrong place is not trusted", () => {
  assert.equal(D.amount("1,10").ambiguous, true);
});

test("amounts on a line: percentages and times are skipped", () => {
  assert.deepEqual(D.amountsIn("(10%対象 ¥1,100 内税 ¥100)").map((a) => a.value), [1100, 100]);
  assert.deepEqual(D.amountsIn("12:34 合計 ¥2,310").map((a) => a.value), [2310]);
});

test("digits OCR often swaps make a value less certain", () => {
  assert.equal(D.swappable(11800), true);
  assert.equal(D.swappable(2244), false);
});

test("法人番号 check digit (published examples)", () => {
  assert.equal(D.corporateCheckDigitOk("7000012050002"), true);   // 国税庁
  assert.equal(D.corporateCheckDigitOk("1180301018771"), true);
  assert.equal(D.corporateCheckDigitOk("2180301018771"), false);
});

test("registration number: found / misread / labelled but unreadable / not there", () => {
  assert.deepEqual(D.invoice("登録番号 T7000012050002").status, "registered");
  const fixed = D.invoice("登録番号 T70000l2O50002");
  assert.equal(fixed.value, "T7000012050002");
  assert.equal(fixed.status, "uncertain", "characters had to be fixed");
  assert.equal(D.invoice("登録番号 T70000120500").status, "uncertain", "12 digits");
  assert.equal(D.invoice("登録番号：＊＊＊＊").status, "uncertain", "a label without a readable number is not proof of none");
  assert.equal(D.invoice("合計 ¥1,100\nありがとうございました").status, "not_found");
  assert.equal(D.invoice("株式会社テスト\n登録番号 T2180301018771", { corporate: true }).status, "uncertain", "corporate check digit fails");
  assert.equal(D.invoice("カード番号 74980000000080241").status, "not_found", "7 + digits outside a 登録番号 line is not a T number");
});

test("dates: 西暦, 令和, two-digit years, O misread as 0", () => {
  assert.equal(D.date("2026年9月28日(月) 12:34", 2026).value, "2026-09-28");
  assert.equal(D.date("令和8年9月28日", 2026).value, "2026-09-28");
  assert.equal(D.date("R8.9.28", 2026).value, "2026-09-28");
  assert.equal(D.date("26/09/28 12:00", 2026).value, "2026-09-28");
  const o = D.date("2026/O9/28", 2026);
  assert.equal(o.value, "2026-09-28");
  assert.ok(o.corrected.length);
});
