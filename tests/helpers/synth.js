// Invented receipt-like images for image-quality tests (no real receipts): a white paper on a darker table,
// rows of "characters" (dark blocks) with item names on the left and prices on the right.
export function receiptImage({ w = 700, h = 1000, seed = 7, paper = 235, table = 90, lineGap = 26, charH = 12 } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = new Uint8ClampedArray(w * h).fill(table);
  const px0 = Math.round(w * 0.2), px1 = Math.round(w * 0.8), py0 = Math.round(h * 0.05), py1 = Math.round(h * 0.95);
  for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) g[y * w + x] = paper;
  const ink = (x0, y0, ww, hh) => { for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = 30; };
  for (let y = py0 + 30; y < py1 - 30; y += lineGap) {
    let x = px0 + 20; const n = 3 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) { const cw = 8 + Math.floor(rnd() * 4); ink(x, y, cw, charH); x += cw + 3; }
    let xr = px1 - 20; for (let i = 0; i < 4; i++) { xr -= 9; ink(xr, y, 7, charH); xr -= 2; }
  }
  return { gray: g, width: w, height: h, originalWidth: w * 3 };
}
export function blur(img, r) {
  const { gray, width: w, height: h } = img; let a = gray.slice();
  for (let pass = 0; pass < 2; pass++) {
    const b = new Uint8ClampedArray(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) { const xx = pass ? x : x + d, yy = pass ? y + d : y; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += a[yy * w + xx]; n++; } }
      b[y * w + x] = s / n;
    }
    a = b;
  }
  return { ...img, gray: a };
}
export const map = (img, f) => ({ ...img, gray: img.gray.map((v, i) => f(v, i % img.width, Math.floor(i / img.width))) });
export function cropRows(img, from) {
  const y0 = Math.round(img.height * from);
  return { ...img, gray: img.gray.slice(y0 * img.width), height: img.height - y0 };
}
