// Image quality check and preprocessing (document-intelligence/quality.js, preprocess.js) on invented images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";
import { receiptImage, blur, map, cropRows } from "./helpers/synth.js";

const Q = load("document-intelligence/quality.js"), P = load("document-intelligence/preprocess.js");
const base = receiptImage();

test("a clean photo passes with no warnings", () => {
  const q = Q.analyze(base);
  assert.deepEqual(q.warnings, []);
  assert.equal(q.retake, false);
  assert.ok(q.score >= 90, "score " + q.score);
  assert.ok(q.paperBox.found && Math.abs(q.paperBox.x - 0.2) < 0.03);
  for (const k of ["score", "blurScore", "brightnessScore", "contrastScore", "skewAngle", "rotation", "hasGlare", "hasShadow", "isCropped", "warnings"]) assert.ok(k in q, k);
});

test("a blurred photo is flagged and a retake recommended", () => {
  const q = Q.analyze(blur(base, 4));
  assert.ok(q.warnings.includes("blur"), q.warnings.join());
  assert.equal(q.retake, true);
});

test("too dark", () => {
  const q = Q.analyze(map(base, (v) => v * 0.27));
  assert.ok(q.warnings.includes("dark"));
  assert.equal(q.retake, true);
});

test("glare: a burnt-out patch on the paper", () => {
  const q = Q.analyze(map(base, (v, x, y) => ((x - 350) ** 2 + (y - 500) ** 2 < 70 ** 2 ? 255 : v)));
  assert.ok(q.hasGlare, JSON.stringify(q.measured));
});

test("a scan (pure white paper everywhere) is not glare", () => {
  const scan = map(receiptImage({ paper: 255, table: 255 }), (v) => v);
  assert.equal(Q.analyze(scan).hasGlare, false);
});

test("shadow: the paper gets gradually darker towards one side", () => {
  const q = Q.analyze(map(base, (v, x) => (v > 200 ? v * (1 - 0.5 * Math.max(0, (x - 140) / 420)) : v)));
  assert.ok(q.hasShadow, JSON.stringify(q.measured));
});

test("text cut off at the top edge (the crop runs through a line of text)", () => {
  const q = Q.analyze(cropRows(base, 0.31));
  assert.ok(q.isCropped && q.croppedSides.includes("top"), JSON.stringify(q.croppedSides));
});

test("low resolution", () => {
  const q = Q.analyze({ ...base, originalWidth: 500 });
  assert.ok(q.warnings.includes("lowResolution"));
});

test("skew is measured and deskewing straightens it", () => {
  const tilted = P.rotate(base, 6);
  const q = Q.analyze(tilted);
  assert.ok(Math.abs(Math.abs(q.skewAngle) - 6) < 1.2, "measured " + q.skewAngle);
  assert.ok(q.warnings.includes("skew"));
  const fixed = P.apply(tilted, P.plan(q).filter((s) => s.op !== "stretch"));
  assert.ok(Math.abs(Q.analyze(fixed).skewAngle) < 1.5, "after " + Q.analyze(fixed).skewAngle);
});

test("preprocessing never changes its input (the original stays as it was)", () => {
  const copy = base.gray.slice();
  P.apply(base, [{ op: "deskew", angle: 3 }, { op: "stretch" }, { op: "denoise" }, { op: "sharpen" }, { op: "rotate90", turns: 1 }]);
  assert.deepEqual(base.gray, copy);
});

test("quarter turns: four turns give the same image back", () => {
  let img = { gray: new Uint8ClampedArray([1, 2, 3, 4, 5, 6]), width: 3, height: 2 };
  const r1 = P.rotate90(img, 1);
  assert.deepEqual([r1.width, r1.height, ...r1.gray], [2, 3, 4, 1, 5, 2, 6, 3]);
  for (let i = 0; i < 4; i++) img = P.rotate90(img, 1);
  assert.deepEqual([...img.gray], [1, 2, 3, 4, 5, 6]);
});

test("plan: sharpen only mild blur, denoise only noise, deskew only real angles", () => {
  assert.deepEqual(P.plan({ skewAngle: 0.5, blurScore: 0.9, warnings: [] }).map((s) => s.op), ["stretch"]);
  assert.deepEqual(P.plan({ skewAngle: 4, blurScore: 0.35, warnings: ["noise"] }).map((s) => s.op), ["deskew", "stretch", "denoise", "sharpen"]);
});

test("messages in three languages for every warning", () => {
  for (const k of Object.keys(Q.MESSAGES)) for (const l of ["ja", "zh", "en"]) assert.ok(Q.message(k, l));
  assert.equal(Q.message("blur", "ja"), "文字がぼやけている");
});
