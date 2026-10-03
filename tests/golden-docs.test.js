// Golden documents (document-intelligence/golden.js): correct document → correct transaction → correct journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const E = load("document-intelligence/evaluate.js"), G = load("document-intelligence/golden.js");
const { results, metrics } = E.run(G.CASES);
const failing = (r) => [...Object.entries(r.fields).filter(([, v]) => !v).map(([k]) => k), ...Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => "check:" + k),
  ...(r.transaction === false ? ["transaction"] : []), ...(r.journal === false ? ["journal"] : [])];

test("every category is covered", () => {
  const cats = new Set(G.CASES.map((c) => c.category));
  for (const c of ["basic", "tax", "invoice", "ocr", "type", "duplicate"]) assert.ok(cats.has(c), c);
  assert.ok(G.CASES.length >= 30);
});

for (const r of results) {
  test(`${r.id} ${r.title}`, () => assert.deepEqual(failing(r), [], JSON.stringify(r.detail)));
}

test("safety: no document passes without review while its journal entry is wrong", () => {
  assert.deepEqual(metrics.falseAutoApprovals, []);
});

test("accuracy floor (field, document, transaction, journal) and duplicates", () => {
  assert.ok(metrics.fieldAccuracy >= 95, "field " + metrics.fieldAccuracy);
  assert.ok(metrics.documentAccuracy >= 90, "document " + metrics.documentAccuracy);
  assert.ok(metrics.journalAccuracy >= 90, "journal " + metrics.journalAccuracy);
  assert.equal(metrics.duplicateDetectionRate, 100);
  assert.equal(metrics.falseDuplicateRate, 0);
});

test("OCR error cases are either corrected (with lower confidence) or sent to review", () => {
  for (const r of results.filter((x) => x.category === "ocr")) assert.ok(r.needsReview, r.id + " must be reviewed");
});
