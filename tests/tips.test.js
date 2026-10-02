// Tips (tips.js): every account the forms offer has a plain-language tip in all three languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const Tips = load("tips.js");
const OCR = load("ocr.js");
const FORM_ACCOUNTS = ["旅費交通費", "通信費", "消耗品費", "会議費", "接待交際費", "新聞図書費", "広告宣伝費", "支払手数料", "外注工賃", "地代家賃", "水道光熱費", "荷造運賃", "研修費", "修繕費", "損害保険料", "租税公課", "福利厚生費", "給料賃金", "利子割引料", "減価償却費", "仕入高", "雑費"];
const PAY = ["事業主借", "現金", "普通預金", "未払金"];

test("every expense and payment account has a tip in ja, zh and en", () => {
  for (const a of FORM_ACCOUNTS) for (const l of ["ja", "zh", "en"]) assert.ok(Tips.ACCOUNT[a] && Tips.ACCOUNT[a][l], a + " " + l);
  for (const a of PAY) for (const l of ["ja", "zh", "en"]) assert.ok(Tips.PAYMENT[a] && Tips.PAYMENT[a][l], a + " " + l);
  for (const k of Object.keys(Tips.FIELD)) for (const l of ["ja", "zh", "en"]) assert.ok(Tips.FIELD[k][l], k + " " + l);
});

test("a meeting receipt paid by card: account, payment, the ○○ placeholder and the invoice hint", () => {
  const list = Tips.forDraft({ accounts: ["会議費", "未払金"], items: OCR.summaryFor("会議費", ""), bizRatio: 100, invoiceNo: "", expense: true }, "ja");
  assert.deepEqual(list.map((x) => x.name || x.kind), ["会議費", "未払金", "items", "invoice"]);
});

test("家事按分 below 100% explains where the private share goes", () => {
  const r = Tips.forDraft({ accounts: ["通信費"], bizRatio: 60, invoiceNo: "T1234567890123", expense: true }, "zh").find((x) => x.kind === "ratio");
  assert.match(r.text, /40%/);
});

test("会議費 摘要 defaults to the meeting template", () => {
  assert.equal(OCR.summaryFor("会議費", "コーヒー"), "○○社担当者との打合せ・会食");
});
