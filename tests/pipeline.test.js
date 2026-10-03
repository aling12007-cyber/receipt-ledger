// Reading pipeline (document-intelligence/pipeline.js): cheap first, vision only when needed, consensus across readings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";

const D = load("document-intelligence/pipeline.js");
const parse = (t) => JSON.parse(t);               // test readings carry their parsed fields as JSON text
const pass = (name, fields, confidence = 0.85) => ({ pass: name, text: JSON.stringify(fields), confidence, words: [], lines: [] });
const localResult = (passes, extra = {}) => ({ ...JSON.parse(passes[0].text), ocr: { provider: "tesseract", passes }, ...extra });

test("local mode: two OCR passes agreeing → consensus, no vision call", async () => {
  let asked = 0;
  const r = await D.run({ mode: "auto", parse,
    local: async () => localResult([pass("standard", { date: "2026-09-28", total: 1100, vendor: "テスト商店" }), pass("full", { date: "2026-09-28", total: 1100, vendor: "テスト商店" })]),
    vision: async () => { asked++; return {}; } });
  assert.equal(asked, 0);
  assert.equal(r.total, 1100);
  assert.deepEqual(r.pipeline, ["local"]);
  assert.equal(r.consensus.total.confidence, 0.85, "two passes of one engine are not independent: no boost");
  assert.equal(r.ocr.passes.length, 2, "OCR words and passes stay with the result");
});

test("auto mode: a missing total asks vision, and the vision reading fills it", async () => {
  const r = await D.run({ mode: "auto", parse,
    local: async () => localResult([pass("standard", { date: "2026-09-28", vendor: "テスト商店" }, 0.7)]),
    vision: async () => ({ date: "2026-09-28", vendor: "テスト商店", total: 2200, amount_10: 2200, confidence: "high", _meta: { model: "m", promptVersion: "receipt-parser-v1" } }) });
  assert.deepEqual(r.pipeline, ["local", "vision"]);
  assert.equal(r.total, 2200);
  assert.deepEqual(r.visionAsked.reasons, ["issueDate:low", "total:missing", "merchantName:low"]);
  assert.equal(r.readings.find((x) => x.kind === "vision").promptVersion, "receipt-parser-v1");
});

test("OCR 11,800 ×2 vs vision 11,300 → 11,800 kept and the conflict reported for review", async () => {
  const r = await D.run({ mode: "auto", parse,
    local: async () => localResult([pass("standard", { date: "2026-09-28", total: 11800, vendor: "A" }, 0.7), pass("full", { date: "2026-09-28", total: 11800, vendor: "A" }, 0.7)]),
    vision: async () => ({ date: "2026-09-28", total: 11300, vendor: "A", confidence: "high" }) });
  assert.equal(r.total, 11800);
  assert.deepEqual(r.conflicts, ["total"]);
});

test("ai mode skips local OCR; a PDF text layer skips OCR and vision when it is clear", async () => {
  let local = 0, vision = 0;
  const r1 = await D.run({ mode: "ai", parse, local: async () => { local++; return {}; }, vision: async () => { vision++; return { total: 500, date: "2026-01-01", vendor: "X", confidence: "high" }; } });
  assert.deepEqual([local, vision, r1.total], [0, 1, 500]);
  const r2 = await D.run({ mode: "auto", parse, text: async () => ({ date: "2026-01-05", total: 3300, vendor: "Y" }),
    local: async () => { local++; return {}; }, vision: async () => { vision++; return {}; } });
  assert.deepEqual([local, vision, r2.total, r2.pipeline[0]], [0, 1, 3300, "pdf-text"]);
});

test("vision failing falls back to the local reading; with nothing at all it is an error", async () => {
  const r = await D.run({ mode: "auto", parse, local: async () => localResult([pass("standard", { total: 900 }, 0.5)]), vision: async () => { throw new Error("down"); } });
  assert.equal(r.total, 900);
  assert.ok(r.pipeline.includes("vision-failed"));
  await assert.rejects(D.run({ mode: "ai", parse, vision: async () => { throw new Error("down"); } }));
});
