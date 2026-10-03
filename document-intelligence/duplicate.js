// Receipt Ledger — Document Intelligence: duplicate receipts.
// duplicateScore 0–1 from: same file (SHA-256), same picture re-photographed (perceptual dHash), same date, total,
// merchant, receipt number, registration number, and similar OCR text. Duplicates are only reported — never deleted.
// Exposes window.DocDuplicate (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Mer = isNode ? require("./merchant.js") : root.DocMerchant;
  /* eslint-enable no-undef */

  const CONFIG = { likely: 0.8, similar: 0.5 };

  /** 64-bit difference hash of a grayscale image (9×8 averages, left/right comparisons), as 16 hex digits. @param {{ gray: ArrayLike<number>, width: number, height: number }} img */
  function dhash(img) {
    const { gray, width: w, height: h } = img, cells = [];
    for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 9; cx++) {
      const x0 = Math.floor((cx * w) / 9), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 9)), y0 = Math.floor((cy * h) / 8), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 8));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y += Math.max(1, Math.floor((y1 - y0) / 8))) for (let x = x0; x < x1; x += Math.max(1, Math.floor((x1 - x0) / 8))) { s += gray[y * w + x]; n++; }
      cells.push(s / n);
    }
    let hex = "";
    for (let row = 0; row < 8; row++) {
      let byte = 0;
      for (let col = 0; col < 8; col++) byte = (byte << 1) | (cells[row * 9 + col] > cells[row * 9 + col + 1] ? 1 : 0);
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }
  /** @param {string} a @param {string} b */
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i += 2) { let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16); while (x) { d += x & 1; x >>= 1; } }
    return d;
  }
  /** Similarity of two OCR texts (character bigrams, Jaccard). */
  function textSimilarity(a, b) {
    const grams = (s) => { const t = String(s || "").replace(/\s/g, ""), g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
    const A = grams(a), B = grams(b);
    if (A.size < 10 || B.size < 10) return 0;
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
  }

  /**
   * @typedef {{ id?: string, date?: string|null, total?: number|null, merchant?: string|null, receiptNumber?: string|null, invoiceNo?: string|null, text?: string, sha256?: string|null, dhash?: string|null }} DocKey
   * @param {DocKey} cand @param {DocKey} other
   */
  function score(cand, other) {
    const reasons = [];
    if (cand.sha256 && cand.sha256 === other.sha256) return { score: 1, reasons: ["same-file"] };
    let s = 0;
    const hd = hamming(cand.dhash || "", other.dhash || "");
    if (hd <= 6) { s += 0.5; reasons.push("same-picture"); } else if (hd <= 10) { s += 0.3; reasons.push("similar-picture"); }
    if (cand.date && cand.date === other.date) { s += 0.2; reasons.push("date"); }
    if (cand.total && cand.total === other.total) { s += 0.3; reasons.push("total"); }
    const m1 = cand.merchant && Mer.normalize(cand.merchant).normalized, m2 = other.merchant && Mer.normalize(other.merchant).normalized;
    if (m1 && m1 === m2) { s += 0.15; reasons.push("merchant"); }
    if (cand.receiptNumber && cand.receiptNumber === other.receiptNumber) { s += 0.3; reasons.push("receipt-number"); }
    if (cand.invoiceNo && cand.invoiceNo === other.invoiceNo) { s += 0.05; reasons.push("registration-number"); }
    const ts = textSimilarity(cand.text, other.text);
    if (ts >= 0.8) { s += 0.3; reasons.push("same-text"); } else if (ts >= 0.6) { s += 0.15; reasons.push("similar-text"); }
    // a different total on the same day from the same shop is a second purchase, not a copy
    if (cand.total && other.total && cand.total !== other.total && !reasons.includes("same-picture")) s *= 0.5;
    return { score: Math.round(Math.min(1, s) * 100) / 100, reasons };
  }

  /**
   * Best matches among existing records.
   * @param {DocKey} cand @param {DocKey[]} existing @param {Partial<typeof CONFIG>} [cfg]
   */
  function find(cand, existing, cfg = {}) {
    const C = { ...CONFIG, ...cfg };
    const hits = existing.map((o) => ({ id: o.id, ...score(cand, o), other: o })).filter((h) => h.score >= C.similar).sort((a, b) => b.score - a.score);
    const top = hits[0];
    return { duplicateScore: top ? top.score : 0, level: !top ? "none" : top.score >= C.likely ? "likely" : "similar", matches: hits.slice(0, 3) };
  }

  const api = { CONFIG, dhash, hamming, textSimilarity, score, find };
  if (isNode) module.exports = api;
  else root.DocDuplicate = api;
})(typeof window !== "undefined" ? window : globalThis);
