// Receipt text parsing (ocr.js), on invented receipt text only — the repository is public, so no real
// receipts or OCR output of real receipts belong here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const O = load("ocr.js");
const parse = (t) => O.parseReceiptText(t, { year: 2026 });

test("dates in every common format", () => {
  const D = (t) => parse("店\n" + t + "\n合計 ¥500").date;
  const cases = [
    ["2026年9月20日", "2026-09-20"], ["2026年09月20日(日) 14:05", "2026-09-20"], ["2026-9-20", "2026-09-20"], ["2026/9/20", "2026-09-20"],
    ["2026.9.20", "2026-09-20"], ["2026 年 9 月 20 日", "2026-09-20"], ["2 0 2 6 年 9 月 2 0 日", "2026-09-20"], ["2026一9一20", "2026-09-20"],
    ["2026ー9ー20", "2026-09-20"], ["2026午9月20日", "2026-09-20"], ["2026/9/2O", "2026-09-20"], ["2026/ 9 / 20", "2026-09-20"],
    ["２０２６年９月２０日", "2026-09-20"], ["令和8年9月20日", "2026-09-20"], ["R8.9.20", "2026-09-20"], ["R08/09/20", "2026-09-20"],
    ["20260920", "2026-09-20"], ["26/09/20", "2026-09-20"], ["9月20日", "2026-09-20"], ["Sep 20, 2026", "2026-09-20"],
    ["09/20/2026", "2026-09-20"], ["9026/09/20", "2026-09-20"], ["発行日：2026年9月20日 TEL 03-1234-5678", "2026-09-20"], ["2026–9–20", "2026-09-20"],
  ];
  for (const [t, want] of cases) assert.equal(D(t), want, t);
});

const pick = (r) => ({ date: r.date, vendor: r.vendor, invoice: r.invoice_no, a10: r.amount_10, a8: r.amount_8, a0: r.amount_other, total: r.total, pay: r.payment });

test("convenience store: 8% and 10% items, registration number, cash", () => {
  const r = parse(`ローソン 新宿三丁目店
東京都新宿区新宿3-1-1
TEL 03-1234-5678
登録番号 T1234567890123
2026年 9月30日(水) 12:34
おにぎり ※ ¥160
コーヒーM ※ ¥180
ボールペン ¥200
小計 ¥540
(8%対象 ¥340)
(10%対象 ¥200)
合 計 ¥540
お預り ¥1,000
お釣り ¥460
※印は軽減税率対象商品`);
  assert.deepEqual(pick(r), { date: "2026-09-30", vendor: "ローソン新宿三丁目店", invoice: "T1234567890123", a10: 200, a8: 340, a0: 0, total: 540, pay: "cash" });
  assert.deepEqual(r.item_list, ["おにぎり", "コーヒーM", "ボールペン"]);
});

test("taxi: 令和 date, spaced registration number, card", () => {
  const r = parse(`東京無線タクシー
領収書
R8.9.28
運賃 1,180円
合計 ¥ 1,180
クレジット VISA
登録番号 T 5011 1010 0123 4`);
  assert.deepEqual(pick(r), { date: "2026-09-28", vendor: "東京無線タクシー", invoice: "T5011101001234", a10: 1180, a8: 0, a0: 0, total: 1180, pay: "card" });
  assert.equal(r.account, "旅費交通費");
});

test("full-width digits and e-money", () => {
  const r = parse(`スターバックス コーヒー
２０２６／０９／２５
ラテ ¥５２０
合計 ￥１，１４０
内消費税(10%) ￥103
電子マネー Suica`);
  assert.equal(r.date, "2026-09-25");
  assert.equal(r.total, 1140);
  assert.equal(r.payment, "emoney");
  assert.equal(r.account, "会議費");
});

test("one receipt, four accounts: exact split by tax class", () => {
  const r = parse(`ファミリーマート 青山店
株式会社ファミリーマート
登録番号 T2013301010706
2026年9月20日(日) 12:31
ボールペン ¥165
コピー用紙 A4 ¥550
※おにぎり ¥151
84円切手 2枚 ¥168
収入印紙 200円 ¥200
小計 ¥1,234
(10%対象 ¥715)
(8%対象 ¥151)
非課税 ¥368
合計 ¥1,234
クレジット`);
  assert.deepEqual(r.lines.map((l) => [l.account, l.amount_10, l.amount_8, l.amount_other]), [
    ["消耗品費", 715, 0, 0], ["租税公課", 0, 0, 200], ["通信費", 0, 0, 168], ["会議費", 0, 151, 0],
  ]);
  const sum = r.lines.reduce((s, l) => s + l.amount_10 + l.amount_8 + l.amount_other, 0);
  assert.equal(sum, r.total);
});

test("restaurant meal is not split into food and drink", () => {
  const r = parse(`VIN TETSU
株式会社ダイナック
2026/9/20
ランチセット ¥1,800
コーヒー ¥500
合計 ¥2,300`);
  assert.equal(r.vendor, "株式会社ダイナック");
  assert.deepEqual(r.lines, []);
  assert.equal(r.account, "会議費");
});

test("golf: play fee to 接待交際費, ゴルフ場利用税 to 租税公課 (不課税)", () => {
  const r = parse(`領収書
2026年08月31日
株式会社サンプルゴルフ
登録番号 T9999999999999
サンプルカントリークラブ
商品 部門 分類 単価 数量 税 金額
セルフプレー代 1 6,680
ゴルフ場利用税 J 800 1 800
ハンバーグ Res 昼 660 1 内 660
練習場ボール M 440 1 内 440
合計 ¥8,580
クレジットカード`);
  assert.deepEqual([r.amount_10, r.amount_other, r.total], [7780, 800, 8580]);
  assert.deepEqual(r.lines.map((l) => [l.account, l.items, l.amount_10, l.amount_other]), [["接待交際費", "ゴルフプレー代", 7780, 0], ["租税公課", "ゴルフ場利用税", 0, 800]]);
  assert.deepEqual(r.item_list, ["セルフプレー代×1", "ゴルフ場利用税×1", "ハンバーグ", "練習場ボール"]);
});

test("foreign currency is not booked in yen", () => {
  const r = parse(`STARBUCKS 星巴克咖啡 上海南京路店
2026-09-18
拿铁 ¥32.00
合计 ¥32.00
支付宝`);
  assert.equal(r.total, 0);
  assert.equal(r.currency, "CNY");
});
