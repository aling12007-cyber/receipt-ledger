// OCR provider registry and ensemble (document-intelligence/providers.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const P = load("document-intelligence/providers.js");
const reading = (provider, kind, parsed, confidence = 0.8) => ({ provider, kind, parsed, confidence });

test("providers are registered behind one interface and can be swapped", async () => {
  P.clear();
  P.register({ id: "fake-a", kind: "local", extract: async () => ({ provider: "fake-a", parsed: { total: 1 } }) });
  P.register({ id: "fake-v", kind: "vision", available: () => false, extract: async () => ({}) });
  assert.deepEqual(P.available().map((p) => p.id), ["fake-a"]);
  assert.equal((await P.get("fake-a").extract({})).parsed.total, 1);
  assert.throws(() => P.register({ id: "bad" }));
});

test("two OCR readings of ¥11,800 outvote one vision reading of ¥11,300 → consensus ¥11,800, flagged", () => {
  const c = P.consensus([
    ...P.candidates(reading("ocr-a", "local", { total: "¥11,800" })),
    ...P.candidates(reading("ocr-b", "local", { total: 11800 })),
    ...P.candidates(reading("vision", "vision", { total: 11300 })),
  ]);
  assert.equal(P.norm("total", c.total.value), 11800);
  assert.deepEqual(c.total.providers, ["ocr-a", "ocr-b"]);
  assert.equal(c.total.conflict, true, "a vision reading at 0.8×0.8 is more than half of two OCR readings → review");
  assert.ok(c.total.confidence <= 0.6);
});

test("all readers agree → high confidence; a lone reading keeps its own confidence", () => {
  const c = P.consensus([
    ...P.candidates(reading("ocr-a", "local", { date: "2026/9/28", total: 1100 }, 0.9)),
    ...P.candidates(reading("vision", "vision", { date: "2026-09-28", total: 1100 }, 0.9)),
  ]);
  assert.equal(c.issueDate.conflict, false);
  assert.ok(c.issueDate.confidence >= 0.95, String(c.issueDate.confidence));
  assert.equal(P.level(c.total.confidence), "high");
  const lone = P.consensus(P.candidates(reading("ocr-a", "local", { total: 500 }, 0.7)));
  assert.equal(lone.total.confidence, 0.7);
});

test("a PDF text layer outweighs OCR", () => {
  const c = P.consensus([
    ...P.candidates(reading("pdf-text", "text", { total: 3300 }, 0.95)),
    ...P.candidates(reading("ocr-a", "local", { total: 3800 }, 0.6)),
  ]);
  assert.equal(c.total.value, 3300);
});

test("normalization: dates, yen amounts, company forms and invoice numbers", () => {
  assert.equal(P.norm("issueDate", "2026年9月8日"), "2026-09-08");
  assert.equal(P.norm("total", "¥1,100-"), 1100);
  assert.equal(P.norm("merchantName", "株式会社 テスト"), P.norm("merchantName", "テスト(株)"));
  assert.equal(P.norm("invoiceRegistrationNumber", "t 1234-5678-90123"), "T1234567890123");
});

test("vision is asked only when a key field is missing, uncertain or in conflict", () => {
  const good = P.consensus([...P.candidates(reading("a", "local", { date: "2026-09-28", total: 1100, vendor: "テスト" }, 0.9)),
    ...P.candidates(reading("b", "local", { date: "2026-09-28", total: 1100, vendor: "テスト" }, 0.9))]);
  assert.equal(P.needsVision(good).ask, false);
  const weak = P.consensus(P.candidates(reading("a", "local", { total: 1100 }, 0.6)));
  assert.deepEqual(P.needsVision(weak).reasons, ["issueDate:missing", "total:low", "merchantName:missing"]);
});
