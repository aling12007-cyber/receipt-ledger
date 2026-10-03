// Document Intelligence data model (document-intelligence/model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const M = load("document-intelligence/model.js");

test("an empty extraction has every field, nothing known, invoice not found yet", () => {
  const e = M.emptyExtraction();
  for (const f of M.FIELDS) assert.ok(e[f] && "value" in e[f] && "confidence" in e[f], f);
  assert.equal(e.invoiceStatus.value, "not_found");
  assert.deepEqual(e.items, []);
  assert.deepEqual(e.taxBreakdown, []);
});

test("bounding boxes are stored normalized so they can be drawn at any size", () => {
  assert.deepEqual(M.normBox({ x0: 100, y0: 50, x1: 300, y1: 100 }, 1000, 500), { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
  assert.deepEqual(M.unionBox([{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, null, { x: 0.3, y: 0.15, width: 0.1, height: 0.1 }]),
    { x: 0.1, y: 0.1, width: 0.3, height: 0.15 });
});

test("OCR results keep words with confidence and bbox", () => {
  const r = M.ocrResult({ provider: "tesseract", words: [{ text: "合計", confidence: 0.9, bbox: { x: 0, y: 0, width: 0.1, height: 0.02 } }, { text: "¥1,100", confidence: 0.7, bbox: null }] });
  assert.equal(r.text, "合計 ¥1,100");
  assert.equal(r.words[0].bbox.width, 0.1);
  assert.ok(Math.abs(r.confidence - 0.8) < 1e-9);
});

test("review lifecycle: posted is final; confirmed can go back to review", () => {
  assert.ok(M.canMove("ai_suggested", "needs_review"));
  assert.ok(M.canMove("needs_review", "user_confirmed"));
  assert.ok(M.canMove("user_confirmed", "posted"));
  assert.ok(!M.canMove("posted", "needs_review"));
  assert.ok(!M.canMove("ocr_result", "posted"), "nothing reaches the books without confirmation");
});

test("a processing run records provider, model, prompt and engine version", () => {
  const r = M.processingRun({ provider: "vision", model: "claude-x", promptVersion: "receipt-parser-v1", docType: "nonsense" });
  assert.equal(r.prompt_version, "receipt-parser-v1");
  assert.equal(r.engine_version, M.ENGINE_VERSION);
  assert.equal(r.doc_type, "receipt");
});

test("field edits: only changed fields, with original, AI and user values", () => {
  const e = M.fieldEdits({ total: 1100 }, { total: 1100, debit: "会議費" }, { total: 1180, debit: "会議費" }, ["total", "debit"]);
  assert.deepEqual(e, [{ field: "total", original_value: 1100, ai_value: 1100, user_value: 1180 }]);
});

test("sha256 of the original file", async () => {
  assert.equal(await M.sha256(new TextEncoder().encode("abc").buffer), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
