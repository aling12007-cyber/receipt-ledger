// Structured extraction, classification, validation and field confidence (document-intelligence/*). Invented receipts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const OCR = load("ocr.js"), X = load("document-intelligence/extract.js"), V = load("document-intelligence/validate.js");
const C = load("document-intelligence/confidence.js"), K = load("document-intelligence/classify.js");
const read = (text, o = {}) => {
  const r = OCR.parseReceiptText(text, { year: 2026 });
  const e = X.extract({ text, r, year: 2026, readingConfidence: o.conf ?? 0.9, lines: o.lines });
  const val = V.validate(e, { year: 2026, today: "2026-10-03" });
  return { r, e, val, conf: C.score(e, { validation: val, consensus: o.consensus }) };
};

const MIXED = `テスト商店 新宿店
東京都新宿区西新宿1-2-3
TEL 03-1234-5678
登録番号 T7000012050002
2026年9月28日(月) 12:34
レシートNo.0042
ボールペン ¥5,500
※お茶 ¥3,240
小計 ¥8,740
(10%対象 ¥5,500 内税 ¥500)
(8%対象 ¥3,240 内税 ¥240)
合計 ¥8,740
クレジット ¥8,740`;

test("a mixed 10% / 8% receipt: every field structured, with the tax breakdown", () => {
  const { e, val, conf } = read(MIXED);
  assert.equal(e.documentType.value, "receipt");
  assert.equal(e.issueDate.value, "2026-09-28");
  assert.equal(e.merchantAddress.value, "東京都新宿区西新宿1-2-3");
  assert.equal(e.phoneNumber.value, "03-1234-5678");
  assert.equal(e.receiptNumber.value, "0042");
  assert.equal(e.invoiceRegistrationNumber.value, "T7000012050002");
  assert.equal(e.invoiceStatus.value, "registered");
  assert.equal(e.subtotal.value, 8740);
  assert.equal(e.total.value, 8740);
  assert.equal(e.paymentMethod.value, "card");
  assert.deepEqual(e.taxBreakdown.map((b) => [b.rate, b.taxableAmount, b.taxAmount]), [[10, 5500, 500], [8, 3240, 240]]);
  assert.equal(e.taxTotal.value, 740);
  assert.equal(val.status, "ok", JSON.stringify(val.checks.filter((c) => c.level !== "ok")));
  assert.equal(conf.needsReview, false);
});

test("税抜 receipt: 10%対象 ¥5,000 + 8%対象 ¥3,000 + 消費税 ¥740 = ¥8,740", () => {
  const { e, val } = read(`テスト食堂\n2026/09/28\n外税\n10%対象 ¥5,000\n8%対象 ¥3,000\n小計 ¥8,000\n消費税等 ¥740\n合計 ¥8,740`);
  assert.equal(e.taxInclusive, false);
  assert.equal(e.taxTotal.value, 740);
  assert.equal(val.inclusive, false);
  assert.equal(val.checks.find((c) => c.code === "SUBTOTAL_TOTAL").level, "ok");
});

test("wrong tax on the receipt (OCR misread 500 → 580) is an error and blocks automatic posting", () => {
  const { val, conf } = read(MIXED.replace("内税 ¥500", "内税 ¥580"));
  assert.equal(val.status, "error");
  assert.ok(val.checks.some((c) => c.code === "RATE_TAX" && c.level === "error"));
  assert.equal(val.blockAutoPost, true);
  assert.equal(conf.needsReview, true);
});

test("subtotal + tax − discount must equal the total", () => {
  const { val } = read(`テスト電器\n2026/09/28\n外税\n小計 ¥10,000\n値引 -¥1,000\n消費税等 ¥900\n合計 ¥9,900`);
  assert.equal(val.checks.find((c) => c.code === "SUBTOTAL_TOTAL").level, "ok");
  const bad = read(`テスト電器\n2026/09/28\n外税\n小計 ¥10,000\n値引 -¥1,000\n消費税等 ¥900\n合計 ¥9,000`);
  assert.equal(bad.val.checks.find((c) => c.code === "SUBTOTAL_TOTAL").level, "error");
});

test("非課税 / 不課税 / 免税 lines are parsed as their own categories", () => {
  const { e } = read(`テスト郵便局\n2026/09/28\n切手 非課税 ¥840\n収入印紙 不課税 ¥200\n合計 ¥1,040`);
  const cat = Object.fromEntries(e.taxBreakdown.map((b) => [b.category, b.taxableAmount]));
  assert.equal(cat.nontaxable, 840);
  assert.equal(cat.outside, 200);
  const ex = read(`TAX FREE SHOP\n2026/09/28\n免税 ¥5,000\n合計 ¥5,000`);
  assert.equal(ex.e.taxBreakdown[0].category, "exempt");
});

test("登録番号: not read ≠ none — no number gives not_found, a smudged one gives uncertain + warning", () => {
  assert.equal(read(`テスト商店\n2026/09/28\n合計 ¥1,100`).e.invoiceStatus.value, "not_found");
  const u = read(`テスト商店\n登録番号 T70000l2O50002\n2026/09/28\n合計 ¥1,100`);
  assert.equal(u.e.invoiceStatus.value, "uncertain");
  assert.ok(u.val.checks.some((c) => c.code === "INVOICE_UNCERTAIN"));
});

test("an OCR-misread total (11,8OO) is corrected but its confidence drops", () => {
  const clean = read(`テスト商店\n2026/09/28\n合計 ¥11,800`), smudged = read(`テスト商店\n2026/09/28\n合計 ¥11,8OO`);
  assert.equal(smudged.e.total.value, clean.e.total.value);
  assert.ok(smudged.conf.fields.total.score < clean.conf.fields.total.score);
  assert.ok(smudged.conf.fields.total.reasons.includes("corrected"));
});

test("a missing date or total means review, never automatic", () => {
  const { val, conf } = read(`テスト商店\n合計 ¥1,100`);
  assert.ok(val.checks.some((c) => c.code === "DATE_MISSING"));
  assert.equal(conf.needsReview, true);
  assert.equal(conf.status, "needs_review");
});

test("a future date is an error; another year is a warning", () => {
  assert.ok(read(`テスト\n2026/12/24\n合計 ¥500`).val.checks.some((c) => c.code === "DATE_FUTURE"));
  assert.ok(read(`テスト\n2025/12/24\n合計 ¥500`).val.checks.some((c) => c.code === "DATE_OTHER_YEAR" && c.level === "warning"));
});

test("readers in conflict cap the field's confidence (ensemble → review)", () => {
  const { conf } = read(MIXED, { consensus: { total: { value: 8740, conflict: true, confidence: 0.6, providers: ["tesseract", "vision"] } } });
  assert.ok(conf.fields.total.score <= 0.6);
  assert.equal(conf.needsReview, true);
});

test("thresholds are configuration", () => {
  assert.equal(C.level(0.9), "medium");
  assert.equal(C.level(0.9, { high: 0.85 }), "high");
});

test("bounding boxes come from the OCR line the value was read on", () => {
  const lines = MIXED.split("\n").map((t, i) => ({ text: t, confidence: 0.93, bbox: { x: 0.1, y: i * 0.07, width: 0.6, height: 0.03 } }));
  const { e } = read(MIXED, { lines });
  assert.deepEqual(e.total.bbox, { x: 0.1, y: 11 * 0.07, width: 0.6, height: 0.03 });
  assert.equal(e.issueDate.bbox.y, 4 * 0.07);
  assert.ok(e.taxBreakdown[0].bbox);
});

test("classification: receipt, invoice, utility bill, delivery note, card / bank statements, contract", () => {
  assert.equal(K.classify("領収書\n上記正に領収いたしました\n合計 ¥1,000").type, "receipt");
  assert.equal(K.classify("請求書\nご請求金額 ¥55,000\nお支払期限 2026/10/31\n振込先 テスト銀行").type, "invoice");
  assert.equal(K.classify("電気ご使用量のお知らせ\nご使用期間 9/1-9/30\nご使用量 250kWh\nご請求金額 ¥8,000").type, "bill");
  assert.equal(K.classify("納品書\n下記の通り納品いたします").type, "delivery_note");
  const card = K.classify("カードご利用代金明細\nご利用日 ご利用店名 ご利用金額");
  assert.equal(card.type, "credit_card_statement");
  assert.equal(card.multiple, true);
  assert.equal(K.classify("普通預金通帳\nお預入れ お引出し 残高").type, "bank_statement");
  assert.equal(K.classify("業務委託契約書\n甲は乙に対し\n第1条 契約期間").type, "contract");
});

test("a statement is flagged: many transactions belong in CSV import, not one entry", () => {
  const { val } = read("カードご利用代金明細\nご利用日 ご利用店名\n2026/09/01 テスト ¥1,000\n合計 ¥1,000");
  assert.ok(val.checks.some((c) => c.code === "STATEMENT" && c.level === "error"));
});

test("real-world OCR noise: '対象' misread, ¥ read as \\, labels lost — the arithmetic still finds base and tax", () => {
  const text = "テスト商店\n2026/09/28\n小計 \\8,740\n(10% xt ¥5,500 内税¥500)\n(8% xt FR ¥3,240 ABE ¥240)\n合計 -¥8,740";
  const { e, val } = read(text);
  assert.deepEqual(e.taxBreakdown.map((b) => [b.rate, b.taxableAmount, b.taxAmount]), [[10, 5500, 500], [8, 3240, 240]]);
  assert.equal(val.status, "ok", JSON.stringify(val.checks.filter((c) => c.level !== "ok")));
});

test("the cash handed over is not the total: 合計 ¥5,500, 現金 ¥6,000, お釣り ¥500", () => {
  const { e } = read("テスト商店\n2026/09/28\n小計 ¥5,500\n合計 ¥5,500\n現金 ¥6,000\nお釣り ¥500");
  assert.equal(e.total.value, 5500);
});

test("'合計 -¥8,740': a dash between label and amount is not a minus sign", () => {
  const lines = ["テスト商店", "2026/09/28", "合計 -¥8,740", "クレジット ¥8,740"].map((t, i) => ({ text: t, confidence: 0.9, bbox: { x: 0, y: i / 10, width: 1, height: 0.05 } }));
  const { e } = read("テスト商店\n2026/09/28\n合計 -¥8,740\nクレジット ¥8,740", { lines });
  assert.equal(e.total.value, 8740);
  assert.equal(e.total.bbox.y, 0.2, "the box is the 合計 line, not the card line");
});
