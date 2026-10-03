// Golden image defects (document-intelligence/golden.js IMAGE_CASES) on invented images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers/load.js";
import { receiptImage, blur, map, cropRows } from "./helpers/synth.js";

const Q = load("document-intelligence/quality.js"), P = load("document-intelligence/preprocess.js"), G = load("document-intelligence/golden.js");
const base = receiptImage();
const make = {
  scan: () => receiptImage({ paper: 255, table: 255 }),
  phone: () => base,
  rotate90: () => ({ ...P.rotate90(base, 1), originalWidth: base.originalWidth }),
  skew: () => ({ ...P.rotate(base, 6, 90), originalWidth: base.originalWidth }),   // the table shows in the corners, as in a photo
  shadow: () => map(base, (v, x) => (v > 200 ? v * (1 - 0.5 * Math.max(0, (x - 140) / 420)) : v)),
  glare: () => map(base, (v, x, y) => ((x - 350) ** 2 + (y - 500) ** 2 < 70 ** 2 ? 255 : v)),
  blur: () => blur(base, 4),
  lowres: () => ({ ...base, originalWidth: 400 }),
  crop: () => cropRows(base, 0.31),
  dark: () => map(base, (v) => v * 0.27),
};

for (const c of G.IMAGE_CASES) {
  test(`${c.id} ${c.title}`, () => {
    const q = Q.analyze(make[c.defect]());
    if (c.expectWarnings) {
      if (!c.expectWarnings.length) assert.deepEqual(q.warnings, [], "no warnings expected");
      for (const w of c.expectWarnings) assert.ok(q.warnings.includes(w), `${w} expected, got ${q.warnings.join(",")}`);
    }
    if (c.expectRetake != null) assert.equal(q.retake, c.expectRetake);
  });
}
