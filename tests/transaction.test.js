// Receipt → Transaction → Journal (document-intelligence/transaction.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const T = load("document-intelligence/transaction.js"), Books = load("books.js"), Migrate = load("engine/migrate.js");
const rowLines = (e) => Migrate.rowLines(e, Books);

test("account suggestion: history, AI and rules — agreement raises confidence, with a reason", () => {
  const k = [{ merchant: "Amazon", account: "消耗品費", uses: 6 }];
  const s = T.suggestAccount({ merchant: "AMAZON", knowledge: k, rules: { account: "消耗品費" }, amount: 3300, text: "USBケーブル" });
  assert.equal(s.account, "消耗品費");
  assert.equal(s.source, "history");
  assert.ok(s.confidence > 0.8);
  assert.match(s.reason.ja, /6回/);
  const ai = T.suggestAccount({ ai: { account: "会議費", confidence: "high" }, rules: { account: "接待交際費" } });
  assert.equal(ai.account, "会議費");
  assert.deepEqual(ai.alternatives, [{ account: "接待交際費", source: "rules" }]);
  assert.equal(T.suggestAccount({}).source, "default");
});

test("MacBook Pro ¥250,000 is a fixed-asset candidate, not supplies", () => {
  const s = T.suggestAccount({ rules: { account: "消耗品費" }, amount: 250000, text: "MacBook Pro 14", date: "2026-09-28", blue: true });
  assert.deepEqual(s.fixedAssetCandidate, { cost: 250000, assetClass: "small" });   // under ¥400,000 (2026-04 – 2029-03), blue return
  assert.equal(T.suggestAccount({ rules: { account: "消耗品費" }, amount: 450000, text: "MacBook Pro", date: "2026-09-28" }).fixedAssetCandidate.assetClass, "depreciate");
  assert.equal(T.suggestAccount({ rules: { account: "会議費" }, amount: 120000, text: "懇親会" }).fixedAssetCandidate, null);
  assert.equal(T.suggestAccount({ rules: { account: "消耗品費" }, amount: 9800, text: "マウス" }).fixedAssetCandidate, null);
});

test("transaction from a reviewed receipt: amount, tax, rate, category, payment, source document, status", () => {
  const entry = { date: "2026-09-28", vendor: "ローソン 新宿店", amt10: 1100, amt8: 540, amt0: 0, debit: "会議費", credit: "未払金", bizRatio: 100, invoiceNo: "T7000012050002" };
  const tx = T.fromReview({ entry, totalOf: Books.totalOf, sourceDocument: "u1/2026-09/a.jpg", suggestion: { account: "会議費", confidence: 0.8 } });
  assert.equal(tx.amount, 1640);
  assert.equal(tx.tax, 100 + 40);
  assert.deepEqual(tx.taxRate, [10, 8]);
  assert.equal(tx.taxCategory, "mixed");
  assert.equal(tx.merchant.normalized, "ローソン");
  assert.equal(tx.sourceDocumentId, "u1/2026-09/a.jpg");
  assert.equal(tx.status, "user_confirmed");
});

test("journal from a transaction balances (debits = credits), with 家事按分 and tax", () => {
  const j = T.toJournal({ type: "expense", date: "2026-09-28", amt10: 11000, amt8: 0, amt0: 0, debit: "通信費", credit: "未払金", bizRatio: 60 }, rowLines);
  assert.equal(j.balanced, true);
  assert.equal(j.debit, 11000);
  const bad = T.toJournal({}, () => [{ account: "消耗品費", dr: 100, cr: 0 }, { account: "現金", dr: 0, cr: 90 }]);
  assert.equal(bad.balanced, false);
});
