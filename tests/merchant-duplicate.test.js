// Merchant normalization / knowledge and duplicate detection (document-intelligence/merchant.js, duplicate.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";
import { receiptImage, map } from "./helpers/synth.js";

const Mer = load("document-intelligence/merchant.js"), Dup = load("document-intelligence/duplicate.js");

test("ローソン 新宿店 / LAWSON / 株式会社ローソン → ローソン, raw name kept", () => {
  for (const raw of ["ローソン 新宿店", "LAWSON", "株式会社ローソン", "ＬＡＷＳＯＮ"]) {
    const n = Mer.normalize(raw);
    assert.equal(n.normalized, "ローソン", raw);
    assert.equal(n.raw, raw.trim());
  }
  assert.equal(Mer.normalize("ローソン 新宿店").branch, "新宿店");
  assert.equal(Mer.normalize("株式会社テスト商事 渋谷店").normalized, "テスト商事");
  assert.equal(Mer.normalize("テスト(株)").normalized, "テスト");
});

test("knowledge: the user's confirmed choices suggest the account, with confidence growing with use", () => {
  const k = [{ merchant: "Amazon", account: "消耗品費", uses: 5 }, { merchant: "Amazon", account: "新聞図書費", uses: 1 }, { merchant: "NTTドコモ", account: "通信費", uses: 1 }];
  const a = Mer.suggest("AMAZON.CO.JP", k);
  assert.equal(a.account, "消耗品費");
  assert.deepEqual(a.alternatives, [{ account: "新聞図書費", uses: 1 }]);
  assert.ok(a.confidence > Mer.suggest("ドコモ", k).confidence, "five confirmations beat one");
  assert.ok(Mer.suggest("ドコモ", k).confidence < 0.5);
  assert.equal(Mer.suggest("知らない店", k), null);
});

test("knowledge can be built from existing records", () => {
  const k = Mer.fromEntries([{ vendor: "東京電力エナジーパートナー", debit: "水道光熱費" }, { vendor: "TEPCO", debit: "水道光熱費" }, { type: "income", vendor: "A社", debit: "売掛金" }]);
  assert.deepEqual(k, [{ merchant: "東京電力", account: "水道光熱費", uses: 2 }]);
});

test("the same file uploaded twice → score 1", () => {
  assert.equal(Dup.score({ sha256: "abc" }, { sha256: "abc" }).score, 1);
});

test("the same receipt photographed again: similar picture + same date, total, merchant → likely duplicate", () => {
  const img = receiptImage(), again = map(img, (v) => Math.min(255, v * 0.95 + 8));
  const h1 = Dup.dhash(img), h2 = Dup.dhash(again);
  assert.ok(Dup.hamming(h1, h2) <= 6, "hamming " + Dup.hamming(h1, h2));
  const r = Dup.find({ dhash: h2, date: "2026-09-28", total: 1100, merchant: "LAWSON" }, [{ id: "e1", dhash: h1, date: "2026-09-28", total: 1100, merchant: "ローソン 新宿店" }]);
  assert.equal(r.level, "likely");
  assert.equal(r.matches[0].id, "e1");
});

test("same shop, same day, different total → not a duplicate (a second purchase)", () => {
  const r = Dup.find({ date: "2026-09-28", total: 1100, merchant: "ローソン" }, [{ id: "e1", date: "2026-09-28", total: 2300, merchant: "ローソン" }]);
  assert.equal(r.level, "none");
});

test("same receipt number + total + date → likely; different pictures of different receipts → none", () => {
  const r = Dup.find({ date: "2026-09-28", total: 5500, receiptNumber: "0042", merchant: "テスト" }, [{ id: "e2", date: "2026-09-28", total: 5500, receiptNumber: "0042", merchant: "テスト" }]);
  assert.equal(r.level, "likely");
  // two receipts that merely look alike (same layout) are at most "similar", never "likely", without matching facts
  const a = Dup.dhash(receiptImage({ seed: 1 })), b = Dup.dhash(receiptImage({ seed: 99, lineGap: 40 }));
  const r2 = Dup.find({ dhash: a, date: "2026-09-28", total: 800 }, [{ id: "x", dhash: b, date: "2026-09-27", total: 1200 }]);
  assert.notEqual(r2.level, "likely");
});

test("similar OCR text counts; short texts do not", () => {
  const t = "テスト商店 新宿店 東京都新宿区 2026/09/28 ボールペン 550 コピー用紙 550 合計 1,100";
  assert.ok(Dup.textSimilarity(t, t.replace("550", "55O")) > 0.8);
  assert.equal(Dup.textSimilarity("合計", "合計"), 0);
});
