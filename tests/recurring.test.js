// Recurring entries (engine/recurring.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const R = load("engine/recurring.js");
const rent = { id: "rent", name: "事務所家賃", vendor: "テスト不動産", debit: "地代家賃", amount: 50000, rate: "0", bizRatio: 30, day: 27, start: "2026-07" };

test("months from start until today, on the rule's day; future days wait", () => {
  const d = R.due([rent], [], [], "2026-10-03");
  assert.deepEqual(d.auto.map((x) => x.date), ["2026-07-27", "2026-08-27", "2026-09-27"]);
  assert.equal(d.auto[0].amt0, 50000);
  assert.equal(d.auto[0].bizRatio, 30);
  assert.equal(d.auto[0].credit, "事業主借");
});

test("running again creates nothing new; a deleted month stays deleted", () => {
  const first = R.due([rent], [], [], "2026-10-03").auto.map((x) => x.id);
  assert.deepEqual(R.due([rent], first, [], "2026-10-03").auto, []);
  assert.deepEqual(R.due([rent], first.slice(1), ["rec-rent-2026-07"], "2026-10-03").auto, []);
});

test("day 31 in a short month, end month, confirm mode, invalid rules ignored", () => {
  const r = { ...rent, id: "p", day: 31, start: "2026-02", end: "2026-03", auto: false, rate: "10" };
  const d = R.due([r, { id: "bad", start: "2026-01" }], [], [], "2026-10-03");
  assert.deepEqual(d.confirm.map((x) => x.date), ["2026-02-28", "2026-03-31"]);
  assert.equal(d.confirm[0].amt10, 50000);
  assert.deepEqual(d.auto, []);
});
