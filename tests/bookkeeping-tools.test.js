// Backup, bank / card CSV import and invoices (engine/backup.js, engine/bank-import.js, engine/invoices.js). Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const B = load("engine/backup.js"), K = load("engine/bank-import.js"), I = load("engine/invoices.js");
const totalOf = (e) => (+e.amt10 || 0) + (+e.amt8 || 0) + (+e.amt0 || 0);
const ex = (id, date, amt, extra = {}) => ({ id, type: "expense", date, vendor: "テスト商店", amt10: amt, amt8: 0, amt0: 0, debit: "消耗品費", credit: "事業主借", bizRatio: 100, ...extra });

test("backup: round trip, checksum, plan adds and replaces but never deletes", () => {
  const entries = [ex("a", "2026-01-05", 1100), ex("b", "2026-02-01", 2200, { ui: "x" })];
  const file = JSON.stringify(B.make({ entries, settings: { name: "テスト屋" }, knowledge: [{ merchant: "テスト商店", account: "消耗品費", uses: 2 }] }));
  const p = B.parse(file);
  assert.ok(p.ok, p.errors.join());
  assert.equal(p.data.entries.length, 2);
  assert.equal(p.data.entries[1].ui, undefined);
  const plan = B.plan(p.data, [ex("a", "2026-01-05", 1100), ex("b", "2026-02-01", 9999), ex("c", "2026-03-01", 500)]);
  assert.equal(plan.same, 1);
  assert.deepEqual(plan.update.map((e) => e.id), ["b"]);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.keepOnly, 1);
  const tampered = JSON.parse(file); tampered.entries[0].amt10 = 1;
  assert.deepEqual(B.parse(JSON.stringify(tampered)).errors, ["checksum"]);
  assert.deepEqual(B.parse("{}").errors, ["notBackup"]);
  assert.deepEqual(B.parse("nope").errors, ["notJson"]);
  assert.match(B.fileName("テスト 屋", "2026-10-03T00:00:00Z"), /^テスト_屋_2026-10-03\.receiptledger$/);
});

test("bank CSV: Shift_JIS-free parsing, header detection, signs and dates", () => {
  const csv = '"取引日","摘要","お引出し","お預入れ","残高"\r\n"2026/09/01","ﾃｽﾄ電力","3,300","","100,000"\r\n"R8.9.5","振込 テスト株式会社","","55,000","155,000"\r\n2026-09-10,"振込手数料",165,,154835\r\n';
  const rows = K.parseCSV(csv), c = K.detect(rows);
  assert.ok(c.ok);
  const tx = K.toTransactions(rows, c, "bank");
  assert.deepEqual(tx.map((t) => [t.date, t.out, t.in]), [["2026-09-01", 3300, 0], ["2026-09-05", 0, 55000], ["2026-09-10", 165, 0]]);
  assert.equal(K.suggest(tx[2]).account, "支払手数料");
  assert.equal(K.suggest({ desc: "ATM 引出", out: 10000, in: 0 }).source, "personal");
  assert.equal(K.suggest(tx[1]).account, "売上高");
  // card: one signed amount column, spending positive, refund negative
  const card = "ご利用日,ご利用店名,ご利用金額\n2026/09/03,テストカフェ,880\n2026/09/04,テスト返品,-500\n";
  const cr = K.parseCSV(card), cc = K.detect(cr);
  assert.deepEqual(K.toTransactions(cr, cc, "card").map((t) => [t.out, t.in]), [[880, 0], [0, 500]]);
  assert.equal(K.parseAmount("△1,200"), -1200);
  assert.equal(K.parseDate("令和8年10月3日"), "2026-10-03");
  assert.equal(K.parseDate("2026/02/30"), null);
  assert.equal(K.decode(new TextEncoder().encode("﻿日付")), "日付");
});

test("bank CSV: matching by amount within ±3 days, once each; re-import is recognised", () => {
  const entries = [ex("r1", "2026-09-02", 3300), ex("r2", "2026-09-30", 3300)];
  const tx = [{ line: 2, date: "2026-09-01", desc: "テスト電力", out: 3300, in: 0 }, { line: 3, date: "2026-09-01", desc: "テスト電力2", out: 3300, in: 0 }, { line: 4, date: "2026-09-20", desc: "入金", out: 0, in: 54835 }];
  const invoices = [{ id: "i1", no: "INV-2026-001", status: "issued", total: 55000, issueDate: "2026-09-01" }];
  const m = K.match(tx, entries, { totalOf, invoices });
  assert.deepEqual(m.map((x) => x.status), ["matched", "new", "invoice"]);
  assert.equal(m[0].entry.id, "r1");
  const rec = K.toEntry(tx[1], "水道光熱費", "普通預金");
  assert.equal(rec.credit, "普通預金");
  assert.equal(K.match(tx, [...entries, rec], { totalOf })[1].status, "imported");
});

test("invoice: tax once per rate, required items, sale and payment entries", () => {
  const inv = { id: "x1", no: "", issueDate: "2026-10-03", client: "テスト株式会社", lines: [{ name: "デザイン制作", qty: 1, unit: 99999, rate: 10 }, { name: "菓子", qty: 3, unit: 333, rate: 8 }] };
  const c = I.compute(inv);
  assert.deepEqual([c.net10, c.tax10, c.net8, c.tax8, c.total], [99999, 9999, 999, 79, 99999 + 9999 + 999 + 79]);
  assert.deepEqual(I.validate(inv, { name: "テスト屋", regNo: "T1234" }).errors, ["regNo"]);
  assert.ok(I.validate(inv, { name: "テスト屋", regNo: "T1234567890123" }).ok);
  assert.equal(I.nextNumber([{ no: "INV-2026-007" }, { no: "INV-2025-099" }], "2026-10-03"), "INV-2026-008");
  assert.equal(I.defaultDue("2026-10-03"), "2026-11-30");
  const e = I.toEntry({ ...inv, no: "INV-2026-008" });
  assert.deepEqual([e.debit, e.credit, e.amt10, e.amt8, e.type], ["売掛金", "売上高", 109998, 1078, "income"]);
  const p = I.paymentEntry(inv, { date: "2026-11-30", amount: c.total - 440 });
  assert.deepEqual([p.type, p.amount, p.fee, p.from, p.to], ["collect", c.total, 440, "売掛金", "普通預金"]);
  assert.equal(I.status({ status: "issued", due: "2026-10-01" }, "2026-10-03"), "overdue");
});
