// Receipt Ledger — Document Intelligence: the data model every stage shares.
//   FieldValue    { value, confidence (0–1), bbox (normalized 0–1 of the page) | null, source, raw }
//   OcrWord       { text, confidence (0–1), bbox { x, y, width, height } (normalized 0–1) }
//   OcrResult     { provider, model, text, words[], lines[], width, height, confidence }
//   Extraction    the structured reading of one document (see emptyExtraction)
//   ProcessingRun what was read, by whom, with which prompt — never changed afterwards
//   FieldEdit     one user correction: original / AI / user value, who, when
// Pure functions, no DOM, no network. Exposes window.DocModel (and module.exports for tests).
(function (root) {
  const ENGINE_VERSION = "di-2026.10.1";

  /** Document types and their Japanese names. */
  const DOC_TYPES = {
    receipt: "領収書・レシート", invoice: "請求書", bill: "請求書（公共料金等）", delivery_note: "納品書",
    credit_card_statement: "クレジットカード明細", bank_statement: "通帳・入出金明細", contract: "契約書", other: "その他",
  };

  /** Review lifecycle: OCR result → AI suggested → needs review → user confirmed → posted (or rejected). */
  const STATUS = ["ocr_result", "ai_suggested", "needs_review", "user_confirmed", "posted", "rejected"];
  const NEXT = {
    ocr_result: ["ai_suggested", "needs_review", "rejected"],
    ai_suggested: ["needs_review", "user_confirmed", "rejected"],
    needs_review: ["user_confirmed", "rejected"],
    user_confirmed: ["posted", "needs_review", "rejected"],
    posted: [],
    rejected: [],
  };
  /** @param {string} from @param {string} to */
  const canMove = (from, to) => (NEXT[from] || []).includes(to);

  /** @typedef {{ x: number, y: number, width: number, height: number }} BBox */
  /** @typedef {{ value: any, confidence: number, bbox: BBox|null, source: string, raw?: string, corrected?: string[] }} FieldValue */

  /**
   * @param {any} value
   * @param {{ confidence?: number, bbox?: BBox|null, source?: string, raw?: string, corrected?: string[] }} [o]
   * @returns {FieldValue}
   */
  function field(value, o = {}) {
    const c = o.confidence == null ? (value == null || value === "" ? 0 : 0.5) : o.confidence;
    const f = { value: value ?? null, confidence: Math.max(0, Math.min(1, c)), bbox: o.bbox || null, source: o.source || "", raw: o.raw ?? undefined };
    if (o.corrected && o.corrected.length) f.corrected = o.corrected;
    return f;
  }

  /** Scalar fields of an extraction (each one a FieldValue). */
  const FIELDS = ["documentType", "issueDate", "merchantName", "rawMerchantName", "normalizedMerchantName", "merchantAddress", "phoneNumber",
    "invoiceRegistrationNumber", "invoiceStatus", "receiptNumber", "subtotal", "discount", "total", "taxTotal", "paymentMethod", "currency"];

  /** An empty extraction: every field present, nothing known yet. */
  function emptyExtraction() {
    /** @type {Record<string, any>} */
    const e = {};
    for (const f of FIELDS) e[f] = field(null, { confidence: 0 });
    e.invoiceStatus = field("not_found", { confidence: 0 });
    e.currency = field("JPY", { confidence: 0.5 });
    e.items = [];          // [{ name, quantity, unitPrice, amount, taxRate, taxCategory, bbox, confidence }]
    e.taxBreakdown = [];   // [{ rate (10|8|0), category, taxableAmount, taxAmount, bbox, confidence }]
    e.rawText = "";
    e.confidence = 0;
    return e;
  }

  /** Plain values of an extraction (for forms, tests, comparisons). @param {any} e */
  function values(e) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const f of FIELDS) out[f] = e[f] ? e[f].value : null;
    out.items = (e.items || []).map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, amount: i.amount, taxRate: i.taxRate, taxCategory: i.taxCategory }));
    out.taxBreakdown = (e.taxBreakdown || []).map((t) => ({ rate: t.rate, category: t.category, taxableAmount: t.taxableAmount, taxAmount: t.taxAmount }));
    return out;
  }

  /** @param {number} v */
  const r4 = (v) => Math.round(v * 10000) / 10000;
  /**
   * A bounding box in page pixels → normalized 0–1 (so it can be drawn over the image at any size).
   * @param {{ x0: number, y0: number, x1: number, y1: number }} b @param {number} width @param {number} height
   * @returns {BBox}
   */
  function normBox(b, width, height) {
    const r = r4;
    return { x: r(b.x0 / width), y: r(b.y0 / height), width: r((b.x1 - b.x0) / width), height: r((b.y1 - b.y0) / height) };
  }
  /** Smallest box around several boxes. @param {Array<BBox|null|undefined>} boxes @returns {BBox|null} */
  function unionBox(boxes) {
    const bs = boxes.filter(Boolean);
    if (!bs.length) return null;
    const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
    const x1 = Math.max(...bs.map((b) => b.x + b.width)), y1 = Math.max(...bs.map((b) => b.y + b.height));
    return { x: r4(x0), y: r4(y0), width: r4(x1 - x0), height: r4(y1 - y0) };
  }

  /**
   * @param {{ provider: string, model?: string, text?: string, words?: any[], lines?: any[], width?: number, height?: number, confidence?: number }} o
   */
  function ocrResult(o) {
    const words = (o.words || []).map((w) => ({ text: String(w.text), confidence: Math.max(0, Math.min(1, Number(w.confidence) || 0)), bbox: w.bbox || null }));
    const conf = o.confidence != null ? o.confidence : words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
    return { provider: o.provider, model: o.model || "", text: o.text || words.map((w) => w.text).join(" "), words, lines: o.lines || [], width: o.width || 0, height: o.height || 0, confidence: conf };
  }

  /**
   * One reading of a document. Stored as-is in document_runs; only the review outcome is added later.
   * @param {{ processedPath?: string, originalPath?: string, sha256?: string, dhash?: string, docType?: string, provider: string,
   *   model?: string, promptVersion?: string, quality?: any, rawOcr?: any, structured?: any, confidence?: any, validation?: any, status?: string }} o
   */
  function processingRun(o) {
    return {
      processed_path: o.processedPath || null, original_path: o.originalPath || null, sha256: o.sha256 || null, dhash: o.dhash || null,
      doc_type: DOC_TYPES[o.docType || ""] ? o.docType : "receipt", provider: o.provider, model: o.model || "", prompt_version: o.promptVersion || "",
      engine_version: ENGINE_VERSION, quality: o.quality ?? null, raw_ocr: o.rawOcr ?? null, structured: o.structured ?? null,
      confidence: o.confidence ?? null, validation: o.validation ?? null, status: STATUS.includes(o.status || "") ? o.status : "ai_suggested",
    };
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  /**
   * The user's corrections: one FieldEdit per field whose confirmed value differs from what was suggested.
   * @param {Record<string, any>} original what OCR read @param {Record<string, any>} ai what was suggested @param {Record<string, any>} user what was confirmed
   * @param {string[]} fields
   */
  function fieldEdits(original, ai, user, fields) {
    return fields.filter((f) => !same(ai[f], user[f])).map((f) => ({ field: f, original_value: original[f] ?? null, ai_value: ai[f] ?? null, user_value: user[f] ?? null }));
  }

  /** SHA-256 of a Blob / ArrayBuffer as hex (Web Crypto; also works in Node 20+). @param {ArrayBuffer|Blob} data */
  async function sha256(data) {
    const buf = data instanceof ArrayBuffer ? data : await /** @type {Blob} */ (data).arrayBuffer();
    const h = await root.crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const api = { ENGINE_VERSION, DOC_TYPES, STATUS, canMove, FIELDS, field, emptyExtraction, values, normBox, unionBox, ocrResult, processingRun, fieldEdits, sha256 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocModel = api;
})(typeof window !== "undefined" ? window : globalThis);
