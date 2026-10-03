// Receipt Ledger — Document Intelligence: image preprocessing before OCR.
// Pure operations on grayscale arrays (testable), plus small canvas helpers for the browser.
// The original file is never touched: every step returns a new image.
//   deskew (rotate by the measured skew), rotate90, crop to the paper, contrast stretch, denoise (median 3×3),
//   sharpen (unsharp mask), upscale for small text. Perspective correction is not done (paper corners are not detected).
// Exposes window.DocPreprocess (and module.exports for tests).
(function (root) {
  /** @typedef {{ gray: Uint8ClampedArray, width: number, height: number }} Gray */

  /** Rotate by `deg` degrees (counter-clockwise positive) around the centre, bilinear; `fill` outside (white). @param {Gray} img @param {number} deg @param {number} [fill] @returns {Gray} */
  function rotate(img, deg, fill = 255) {
    const { gray, width: w, height: h } = img, a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const W = Math.round(Math.abs(w * c) + Math.abs(h * s)), H = Math.round(Math.abs(w * s) + Math.abs(h * c));
    const out = new Uint8ClampedArray(W * H).fill(fill), cx = w / 2, cy = h / 2, CX = W / 2, CY = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - CX, dy = y - CY;
      const sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      out[y * W + x] = (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
    }
    return { gray: out, width: W, height: H };
  }

  /** Quarter turns clockwise (1 = 90°, 2 = 180°, 3 = 270°). @param {Gray} img @param {number} q @returns {Gray} */
  function rotate90(img, q) {
    const { gray, width: w, height: h } = img, t = ((q % 4) + 4) % 4;
    if (!t) return { gray: gray.slice(), width: w, height: h };
    const W = t === 2 ? w : h, H = t === 2 ? h : w, out = new Uint8ClampedArray(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (t === 1) out[x * W + (h - 1 - y)] = v;
      else if (t === 2) out[(h - 1 - y) * W + (w - 1 - x)] = v;
      else out[(w - 1 - x) * W + y] = v;
    }
    return { gray: out, width: W, height: H };
  }

  /** Crop to a normalized box (from DocQuality.paperBox) with a small margin. @param {Gray} img @param {{ x: number, y: number, width: number, height: number }} b */
  function crop(img, b, margin = 0.01) {
    const { gray, width: w, height: h } = img;
    const x0 = Math.max(0, Math.floor((b.x - margin) * w)), y0 = Math.max(0, Math.floor((b.y - margin) * h));
    const x1 = Math.min(w, Math.ceil((b.x + b.width + margin) * w)), y1 = Math.min(h, Math.ceil((b.y + b.height + margin) * h));
    const W = x1 - x0, H = y1 - y0, out = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) out.set(gray.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * W);
    return { gray: out, width: W, height: H };
  }

  /** Stretch so the darkest 1% is black and the brightest 1% white. @param {Gray} img @returns {Gray} */
  function stretch(img) {
    const { gray } = img, hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= gray.length * 0.01) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= gray.length * 0.01) { hi = i; break; } }
    const k = 255 / Math.max(1, hi - lo), out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - lo) * k;
    return { gray: out, width: img.width, height: img.height };
  }

  /** Median 3×3 (removes speckle noise, keeps edges). @param {Gray} img @returns {Gray} */
  function denoise(img) {
    const { gray, width: w, height: h } = img, out = gray.slice(), v = new Array(9);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v[k++] = gray[(y + dy) * w + x + dx];
      v.sort((a, b) => a - b); out[y * w + x] = v[4];
    }
    return { gray: out, width: w, height: h };
  }

  /** Unsharp mask (amount 0–2). @param {Gray} img @param {number} [amount] @returns {Gray} */
  function sharpen(img, amount = 0.8) {
    const { gray, width: w, height: h } = img, out = gray.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const blur = (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1] + 2 * gray[i - 1] + 4 * gray[i] + 2 * gray[i + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1]) / 16;
      out[i] = gray[i] + amount * (gray[i] - blur);
    }
    return { gray: out, width: w, height: h };
  }

  /**
   * Which steps to run for a given quality report. Deskew only for a trustworthy angle of 1.5° or more;
   * denoise only on noisy images; sharpen only on mildly blurred ones (a badly blurred photo needs a retake).
   * @param {any} q DocumentQuality
   */
  function plan(q) {
    const steps = [];
    if (q && q.rotation) steps.push({ op: "rotate90", turns: q.rotation / 90 });
    if (q && Math.abs(q.skewAngle || 0) >= 1.5) steps.push({ op: "deskew", angle: q.skewAngle });
    steps.push({ op: "stretch" });
    if (q && q.warnings && q.warnings.includes("noise")) steps.push({ op: "denoise" });
    if (q && q.blurScore != null && q.blurScore < 0.5 && q.blurScore >= 0.2) steps.push({ op: "sharpen", amount: 0.8 });
    return steps;
  }
  /** Run a plan on a grayscale image. @param {Gray} img @param {Array<any>} steps @returns {Gray} */
  function apply(img, steps) {
    let cur = img;
    for (const s of steps) {
      if (s.op === "rotate90") cur = rotate90(cur, s.turns);
      else if (s.op === "deskew") cur = rotate(cur, s.angle);
      else if (s.op === "stretch") cur = stretch(cur);
      else if (s.op === "denoise") cur = denoise(cur);
      else if (s.op === "sharpen") cur = sharpen(cur, s.amount);
    }
    return cur;
  }

  // ---- browser helpers (canvas) ----
  /** Grayscale canvas → Gray. @param {HTMLCanvasElement} canvas */
  function fromCanvas(canvas) {
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { willReadFrequently: true }));
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height), g = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
    return { gray: g, width: canvas.width, height: canvas.height };
  }
  /** Gray → new canvas. @param {Gray} img */
  function toCanvas(img) {
    const c = root.document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    const id = ctx.createImageData(img.width, img.height);
    for (let i = 0, j = 0; j < img.gray.length; i += 4, j++) { id.data[i] = id.data[i + 1] = id.data[i + 2] = img.gray[j]; id.data[i + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    return c;
  }
  /**
   * Colour copy rotated by `angle` degrees (same direction as rotate()) and/or `turns` clockwise quarter turns, white background.
   * @param {CanvasImageSource & { width: number, height: number }} src @param {number} angle @param {number} [turns]
   */
  function rotateCanvas(src, angle, turns = 0) {
    const a = ((angle - turns * 90) * Math.PI) / 180, w = src.width, h = src.height;
    const W = Math.round(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))), H = Math.round(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)));
    const c = root.document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2); ctx.rotate(-a); ctx.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  const api = { rotate, rotate90, crop, stretch, denoise, sharpen, plan, apply, fromCanvas, toCanvas, rotateCanvas };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocPreprocess = api;
})(typeof window !== "undefined" ? window : globalThis);
