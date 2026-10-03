// Receipt Ledger — Document Intelligence: image quality check (before OCR).
// Works on a grayscale pixel array, so it runs the same in the browser (from a canvas) and in tests.
// Measures: resolution, blur, brightness, contrast, skew, glare, shadow, cropping, noise, text visibility.
// Not measured here: perspective distortion (only the paper's bounding box is known) and 90° / 180° turned pages —
// receipts have item | price columns, which fool projection profiles; the OCR step detects turned pages instead.
// Exposes window.DocQuality (and module.exports for tests).
(function (root) {
  /** Thresholds (config, not hard-coded in the checks). */
  const CONFIG = {
    minPaperWidthPx: 500,     // paper narrower than this in the original photo → low resolution
    blurWarn: 0.45, blurSevere: 0.25,   // sharpness score 0–1
    darkWarn: 110, darkSevere: 70,      // paper brightness (0–255)
    brightContrastMin: 45,              // contrast (ink vs paper) below this → text too faint
    skewWarnDeg: 3, skewSevereDeg: 25,      // skew is corrected automatically; only extreme angles need a retake
    glareMinCells: 0.004, glareMaxCells: 0.4,
    shadowRange: 55, shadowMin: 185,
    noiseWarn: 9,
    minInk: 0.003,                      // fraction of the paper that is ink
    retakeBelow: 55,                    // overall score below this → recommend a retake
  };

  /** @typedef {{ gray: ArrayLike<number>, width: number, height: number, originalWidth?: number, originalHeight?: number }} GrayImage */

  function percentile(hist, total, p) {
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * p) return i; }
    return 255;
  }
  function histogram(gray, w, box) {
    const h = new Array(256).fill(0);
    let n = 0;
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) { h[Math.max(0, Math.min(255, Math.round(gray[y * w + x])))]++; n++; }
    return { h, n };
  }
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; t = i; }
    }
    return t;
  }

  /** Text-line angle by projection profiles of the ink pixels; also tells whether lines run vertically (page turned 90°). */
  function skewOf(pts) {
    if (pts.length < 100) return { angle: 0, rotation: 0, strength: 0 };
    const n = pts.length / 2;
    // peakiness of the profile: sum of squares relative to a flat profile over the same span (independent of the paper's shape)
    const score = (a, swap) => {
      const s = Math.sin((a * Math.PI) / 180), c = Math.cos((a * Math.PI) / 180), bins = new Map();
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const x = swap ? pts[i + 1] : pts[i], y = swap ? pts[i] : pts[i + 1];
        const k = Math.round((-x * s + y * c) / 2);
        bins.set(k, (bins.get(k) || 0) + 1); if (k < lo) lo = k; if (k > hi) hi = k;
      }
      let sq = 0; for (const v of bins.values()) sq += v * v;
      return sq / ((n * n) / Math.max(1, hi - lo + 1));
    };
    const search = (swap) => {
      let best = -1, ang = 0;
      for (let a = -20; a <= 20; a += 1) { const v = score(a, swap); if (v > best) { best = v; ang = a; } }
      const c0 = ang;
      for (let a = c0 - 0.9; a <= c0 + 0.9; a += 0.1) { const v = score(a, swap); if (v > best) { best = v; ang = a; } }
      return { best, ang: Math.round(ang * 10) / 10 };
    };
    const hz = search(false), vt = search(true);
    // (vt is kept for diagnostics only.)
    // how much better the found angle is than "straight": low gain → the angle is not trustworthy
    const gain = hz.best / Math.max(1e-9, score(0, false));
    return { angle: gain >= 1.12 ? hz.ang : 0, rotation: 0, strength: hz.best, vertical: vt.best, gain: Math.round(gain * 100) / 100 };
  }

  /**
   * DocumentQuality of one image.
   * @param {GrayImage} img
   * @param {Partial<typeof CONFIG>} [cfg]
   */
  function analyze(img, cfg = {}) {
    const C = { ...CONFIG, ...cfg };
    const { gray, width: w, height: h } = img;
    const all = histogram(gray, w, { x0: 0, y0: 0, x1: w, y1: h });
    const T = otsu(all.h, all.n);

    // 1) block grid: a block is paper when its bright pixels are brighter than the background (Otsu threshold)
    const G = 16, gw = Math.ceil(w / G), gh = Math.ceil(h / G);
    const p90 = new Float32Array(gw * gh), isPaper = new Uint8Array(gw * gh);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      const hb = new Array(32).fill(0); let cnt = 0;
      for (let y = by * G; y < Math.min(h, (by + 1) * G); y += 2) for (let x = bx * G; x < Math.min(w, (bx + 1) * G); x += 2) { hb[gray[y * w + x] >> 3]++; cnt++; }
      let acc = 0, v = 0; for (let i = 0; i < 32; i++) { acc += hb[i]; if (acc >= cnt * 0.9) { v = i * 8 + 4; break; } }
      p90[by * gw + bx] = v;
    }
    let paperBlocks = 0;
    for (let i = 0; i < p90.length; i++) if (p90[i] > Math.max(T + 5, 110)) { isPaper[i] = 1; paperBlocks++; }
    const found = paperBlocks >= p90.length * 0.08;
    if (!found) { isPaper.fill(1); paperBlocks = p90.length; }
    // second pass: paper blocks are those close to the paper's own brightness (drops a light table or wall)
    if (found) {
      const vs = []; for (let i = 0; i < p90.length; i++) if (isPaper[i]) vs.push(p90[i]);
      vs.sort((a, b) => a - b);
      const med = vs[Math.floor(vs.length / 2)];
      paperBlocks = 0;
      for (let i = 0; i < p90.length; i++) { isPaper[i] = isPaper[i] && p90[i] >= med - 60 ? 1 : 0; paperBlocks += isPaper[i]; }
    }
    // close small holes (dense text, a logo) inside the paper
    const hole = [];
    for (let by = 1; by < gh - 1; by++) for (let bx = 1; bx < gw - 1; bx++) {
      const i = by * gw + bx; if (isPaper[i]) continue;
      if (isPaper[i - 1] + isPaper[i + 1] + isPaper[i - gw] + isPaper[i + gw] >= 3) hole.push(i);
    }
    for (const i of hole) { isPaper[i] = 1; paperBlocks++; }
    let bx0 = gw, by0 = gh, bx1 = 0, by1 = 0;
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) if (isPaper[by * gw + bx]) { if (bx < bx0) bx0 = bx; if (by < by0) by0 = by; if (bx > bx1) bx1 = bx; if (by > by1) by1 = by; }
    const box = { x0: bx0 * G, y0: by0 * G, x1: Math.min(w, (bx1 + 1) * G), y1: Math.min(h, (by1 + 1) * G) };

    // 2) paper brightness and contrast from paper pixels only
    const ph = new Array(256).fill(0); let pn = 0;
    const paperVals = [];
    for (let i = 0; i < p90.length; i++) if (isPaper[i]) paperVals.push(p90[i]);
    paperVals.sort((a, b) => a - b);
    const paper = paperVals[Math.floor(paperVals.length / 2)] || 0;
    const step = Math.max(1, Math.floor(Math.sqrt((paperBlocks * G * G) / 400000)));
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
      if (!isPaper[Math.floor(y / G) * gw + Math.floor(x / G)]) continue;
      ph[gray[y * w + x] | 0]++; pn++;
    }
    const p5 = percentile(ph, pn, 0.03), p50 = percentile(ph, pn, 0.5);
    const contrast = Math.max(0, paper - p5);
    const inkT = paper - Math.max(30, contrast * 0.5);

    // 3) ink (skew, text visibility), sharpness at ink edges, background noise — paper pixels only
    const pts = [], lapVals = [];
    let ink = 0, seen = 0, noise = 0, noiseN = 0;
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
      if (!isPaper[Math.floor(y / G) * gw + Math.floor(x / G)]) continue;
      const i = y * w + x, v = gray[i]; seen++;
      if (v < inkT) { ink++; if (pts.length < 100000) pts.push(x, y); }
      const lap = Math.abs(4 * v - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]);
      if (lap > 8) lapVals.push(lap);
      if (v > inkT + 20) {
        const m = (gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w]) / 4;
        if (Math.abs(m - v) < 30) { noise += Math.abs(v - m); noiseN++; }
      }
    }
    lapVals.sort((a, b) => a - b);
    const lapHigh = lapVals.length ? lapVals[Math.floor(lapVals.length * 0.98)] : 0;
    const inkFrac = seen ? ink / seen : 0;
    // A sharp edge between ink and paper gives a Laplacian near 2× the contrast; blur spreads it out.
    const sharp = contrast > 10 ? Math.min(1, lapHigh / (2.2 * contrast)) : 0;
    const noiseLevel = noiseN ? noise / noiseN : 0;

    // 4) glare: burnt-out blocks on a paper that is not white everywhere (a scan is)
    let glareCells = 0;
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      if (!isPaper[by * gw + bx]) continue;
      let sat = 0, cnt = 0;
      for (let y = by * G; y < Math.min(h, (by + 1) * G); y += 2) for (let x = bx * G; x < Math.min(w, (bx + 1) * G); x += 2) { cnt++; if (gray[y * w + x] >= 250) sat++; }
      if (cnt && sat / cnt > 0.7) glareCells++;
    }
    const glareFrac = paperBlocks ? glareCells / paperBlocks : 0;
    const scanLike = paper >= 248;
    const hasGlare = !scanLike && glareFrac >= C.glareMinCells && glareFrac <= C.glareMaxCells;

    // 5) shadow: uneven paper brightness across regions of the page
    const R = 5, regions = [];
    for (let ry = 0; ry < R; ry++) for (let rx = 0; rx < R; rx++) {
      const vs = [];
      for (let by = by0 + Math.floor(((by1 - by0 + 1) * ry) / R); by < by0 + Math.floor(((by1 - by0 + 1) * (ry + 1)) / R); by++)
        for (let bx = bx0 + Math.floor(((bx1 - bx0 + 1) * rx) / R); bx < bx0 + Math.floor(((bx1 - bx0 + 1) * (rx + 1)) / R); bx++)
          if (isPaper[by * gw + bx]) vs.push(p90[by * gw + bx]);
      if (vs.length >= 3) { vs.sort((a, b) => a - b); regions.push(vs[Math.floor(vs.length / 2)]); }
    }
    const rMax = regions.length ? Math.max(...regions) : paper, rMin = regions.length ? Math.min(...regions) : paper;
    const hasShadow = rMax - rMin > C.shadowRange && rMin < C.shadowMin;

    // 6) cropping: the paper runs off an image edge with text right at that edge
    const sides = [];
    const edgeCheck = (name, blocks) => {
      const paperAt = blocks.filter((i) => isPaper[i]);
      if (paperAt.length < blocks.length * 0.25) return;
      let k = 0, m = 0;
      for (const i of paperAt) {
        const bx = i % gw, by = Math.floor(i / gw);
        for (let y = by * G; y < Math.min(h, (by + 1) * G); y += 2) for (let x = bx * G; x < Math.min(w, (bx + 1) * G); x += 2) { m++; if (gray[y * w + x] < inkT) k++; }
      }
      if (m && k / m > Math.max(0.01, inkFrac * 0.5)) sides.push(name);
    };
    const row = (by) => Array.from({ length: gw }, (_, bx) => by * gw + bx), col = (bx) => Array.from({ length: gh }, (_, by) => by * gw + bx);
    edgeCheck("top", row(0)); edgeCheck("bottom", row(gh - 1)); edgeCheck("left", col(0)); edgeCheck("right", col(gw - 1));

    const sk = skewOf(pts);
    const scale = img.originalWidth ? img.originalWidth / w : 1;
    const paperWidthPx = Math.round(Math.min(box.x1 - box.x0, box.y1 - box.y0) * scale);
    const warnings = [];
    const severe = [];
    const add = (code, isSevere) => { warnings.push(code); if (isSevere) severe.push(code); };
    if (paperWidthPx < C.minPaperWidthPx) add("lowResolution", paperWidthPx < C.minPaperWidthPx * 0.6);
    if (sharp < C.blurWarn) add("blur", sharp < C.blurSevere);
    if (paper < C.darkWarn) add("dark", paper < C.darkSevere);
    if (contrast < C.brightContrastMin) add("lowContrast", contrast < C.brightContrastMin * 0.6);
    const layoutOk = paper >= C.darkSevere && inkFrac >= C.minInk && inkFrac < 0.3;
    if (!layoutOk) { /* rotation, skew and cropping cannot be judged on this image */ }
    else if (sk.rotation === 90) add("rotated", false);
    else if (Math.abs(sk.angle) >= C.skewWarnDeg) add("skew", Math.abs(sk.angle) >= C.skewSevereDeg);
    if (hasGlare) add("glare", glareFrac > 0.08);
    if (hasShadow) add("shadow", rMin < 90);
    if (layoutOk && sides.length) add("cropped", sides.length >= 3);
    if (noiseLevel > C.noiseWarn) add("noise", false);
    if (inkFrac < C.minInk) add("noText", true);

    const blurScore = Math.round(sharp * 100) / 100;
    const brightnessScore = Math.round(Math.max(0, Math.min(1, (paper - C.darkSevere) / (200 - C.darkSevere))) * 100) / 100;
    const contrastScore = Math.round(Math.max(0, Math.min(1, contrast / 120)) * 100) / 100;
    const penalty = { lowResolution: 15, blur: 30, dark: 25, lowContrast: 20, rotated: 5, skew: 10, glare: 15, shadow: 10, cropped: 15, noise: 5, noText: 50 };
    let score = 100;
    for (const wcode of warnings) score -= (penalty[wcode] || 10) * (severe.includes(wcode) ? 1.6 : 1);
    score = Math.max(0, Math.round(score));
    return {
      score, blurScore, brightnessScore, contrastScore,
      skewAngle: layoutOk && !sk.rotation ? sk.angle : 0, rotation: layoutOk ? sk.rotation : 0,
      hasGlare, hasShadow, isCropped: layoutOk && sides.length > 0, croppedSides: layoutOk ? sides : [],
      noiseLevel: Math.round(noiseLevel * 10) / 10, inkRatio: Math.round(inkFrac * 10000) / 10000, paperWidthPx,
      paperBox: { x: box.x0 / w, y: box.y0 / h, width: (box.x1 - box.x0) / w, height: (box.y1 - box.y0) / h, found },
      warnings, severe,
      retake: severe.length > 0 || score < C.retakeBelow,
      measured: { paper, contrast, p50, threshold: T, glareFrac: Math.round(glareFrac * 1000) / 1000, shadowRange: rMax - rMin },
    };
  }

  /** Plain-language reasons (ja / zh / en). */
  const MESSAGES = {
    lowResolution: { ja: "解像度が低い（もっと近づいて撮影）", zh: "解析度太低（請靠近一點拍）", en: "Low resolution (move closer)" },
    blur: { ja: "文字がぼやけている", zh: "文字模糊", en: "Text is blurry" },
    dark: { ja: "暗すぎる", zh: "太暗", en: "Too dark" },
    lowContrast: { ja: "文字が薄い・コントラストが低い", zh: "文字太淡、對比太低", en: "Faint text / low contrast" },
    rotated: { ja: "横向きに撮影されている（自動で回転します）", zh: "照片是橫的（會自動轉正）", en: "Photo is sideways (rotated automatically)" },
    skew: { ja: "書類が傾いている", zh: "文件歪斜", en: "Document is tilted" },
    glare: { ja: "光が反射している", zh: "有反光", en: "Glare on the paper" },
    shadow: { ja: "影がかかっている", zh: "有陰影", en: "Shadow on the paper" },
    cropped: { ja: "書類の端が切れている", zh: "文件邊緣被裁切", en: "Edges of the document are cut off" },
    noise: { ja: "画像のノイズが多い", zh: "雜訊多", en: "Noisy image" },
    noText: { ja: "文字が見つからない", zh: "找不到文字", en: "No text found" },
  };
  /** @param {string} code @param {string} lang */
  const message = (code, lang) => (MESSAGES[code] ? MESSAGES[code][lang] || MESSAGES[code].ja : code);

  /** Grayscale of RGBA pixels (canvas ImageData). @param {{ data: ArrayLike<number>, width: number, height: number }} id */
  function toGray(id) {
    const g = new Uint8ClampedArray(id.width * id.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
    return { gray: g, width: id.width, height: id.height };
  }

  const api = { CONFIG, analyze, message, MESSAGES, toGray, skewOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocQuality = api;
})(typeof window !== "undefined" ? window : globalThis);
