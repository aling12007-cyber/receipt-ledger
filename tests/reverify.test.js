// Low-confidence re-reading (document-intelligence/reverify.js): only the doubtful field, rules decide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const R = load("document-intelligence/reverify.js"), M = load("document-intelligence/model.js");
const box = { x: 0.1, y: 0.5, width: 0.5, height: 0.03 };
function receipt({ total = 8740, tax = 740, taxConf = 0.54 } = {}) {
  const e = M.emptyExtraction();
  e.issueDate = M.field("2026-09-28", { confidence: 0.99, bbox: box });
  e.merchantName = M.field("テスト商店", { confidence: 0.97 });
  e.subtotal = M.field(8000, { confidence: 0.96, bbox: box });
  e.taxTotal = M.field(tax, { confidence: taxConf, bbox: box });
  e.total = M.field(total, { confidence: 0.99, bbox: box });
  e.taxInclusive = false;
  return e;
}
const conf = (lowFields) => ({ fields: Object.fromEntries(["issueDate", "merchantName", "subtotal", "taxTotal", "total"].map((f) => [f, { level: lowFields.includes(f) ? "low" : "high" }])) });

test("only the low field is re-read (date 99% / tax 54% → only tax)", async () => {
  const asked = [];
  const { log } = await R.reverify(receipt(), conf(["taxTotal"]), { readRegion: async (b, o) => { asked.push(o); return { text: "¥740", confidence: 0.9 }; }, year: 2026, today: "2026-10-03" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].digits, true);
  assert.equal(log[0].field, "taxTotal");
  assert.equal(log[0].outcome, "reread-agreed");
  assert.ok(log[0].afterConfidence >= 0.9);
});

test("a re-read that makes the arithmetic work replaces a misread (¥790 → ¥740)", async () => {
  const { extraction, log } = await R.reverify(receipt({ tax: 790 }), conf(["taxTotal"]), { readRegion: async () => ({ text: "¥740", confidence: 0.85 }), year: 2026, today: "2026-10-03" });
  assert.equal(extraction.taxTotal.value, 740);
  assert.equal(log[0].outcome, "reread-fixed");
  assert.ok(extraction.taxTotal.corrected.includes("reread"));
});

test("a re-read that breaks the arithmetic is not taken: conflict, confidence capped, vision asked", async () => {
  let visionAsked = 0;
  const { extraction, log } = await R.reverify(receipt(), conf(["taxTotal"]), {
    readRegion: async () => ({ text: "¥790", confidence: 0.6 }),
    vision: async () => { visionAsked++; return { value: 740, legible: true, confidence: "high" }; }, year: 2026, today: "2026-10-03" });
  assert.equal(visionAsked, 1);
  assert.equal(extraction.taxTotal.value, 740);
  assert.equal(log[0].outcome, "vision-agreed");
});

test("vision cannot read it either → value kept, still low, alternatives recorded", async () => {
  const { extraction, log } = await R.reverify(receipt(), conf(["taxTotal"]), {
    readRegion: async () => ({ text: "¥790", confidence: 0.6 }), vision: async () => ({ value: null, legible: false }), year: 2026, today: "2026-10-03" });
  assert.equal(extraction.taxTotal.value, 740);
  assert.ok(extraction.taxTotal.confidence <= 0.5);
  assert.deepEqual(extraction.taxTotal.alternatives, [{ value: 790, source: "reread" }]);
  assert.equal(log[0].outcome, "reread-differs");
});

test("fields without a box, and high fields, are left alone; at most three fields", async () => {
  let n = 0;
  const e = receipt(); e.taxTotal.bbox = null;
  await R.reverify(e, conf(["taxTotal"]), { readRegion: async () => { n++; return { text: "", confidence: 0 }; } });
  assert.equal(n, 0);
});

test("the 合計 line misread (¥5,900) and the cash line taken as total (¥6,000): the labelled line is re-read and the arithmetic picks ¥5,500", async () => {
  const e = M.emptyExtraction();
  e.issueDate = M.field("2026-09-28", { confidence: 0.99 });
  e.merchantName = M.field("テスト商店", { confidence: 0.97 });
  e.subtotal = M.field(5500, { confidence: 0.9, bbox: box });
  e.total = M.field(6000, { confidence: 0.5, bbox: { ...box, y: 0.8 } });
  e.total.alternatives = [{ value: 5900, bbox: { ...box, y: 0.7 }, source: "total-label" }];
  e.taxInclusive = true;
  let regionY = null;
  const { extraction, log } = await R.reverify(e, conf(["total"]), { readRegion: async (b) => { regionY = b.y; return { text: "合計 ¥5,500", confidence: 0.8 }; }, year: 2026, today: "2026-10-03" });
  assert.equal(regionY, 0.7, "the 合計 line is the one read again");
  assert.equal(extraction.total.value, 5500);
  assert.equal(log[0].outcome, "reread-fixed");
  if (extraction.total.value === 5500) assert.equal(extraction.total.bbox.y, 0.7, "the box follows the value to the 合計 line");
});
