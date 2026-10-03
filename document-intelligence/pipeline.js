// Receipt Ledger — Document Intelligence: reading pipeline (cheap first, expensive only when needed).
//   1. text layer (PDF) and/or local OCR  → readings
//   2. consensus per field                → if a key field is missing / uncertain / in conflict:
//   3. vision provider (if available and allowed) → one more reading → consensus again
// The result keeps the receipt-reader shape the review form uses, with consensus values for the key fields,
// plus every reading (provider, model, prompt version) for the processing record.
// Exposes window.DocPipeline (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const P = isNode ? require("./providers.js") : root.DocProviders;
  /* eslint-enable no-undef */

  /** Readings from a local OCR result: one per OCR pass that read the whole page (standard / full / rotated). @param {any} r ReceiptOCR result @param {(t: string) => any} parse */
  function localReadings(r, parse) {
    const passes = (r.ocr && r.ocr.passes) || [];
    const out = [];
    for (const p of passes) {
      if (p.pass === "table") continue;
      out.push({ provider: "tesseract:" + p.pass, kind: "local", model: (r.ocr && r.ocr.model) || "tesseract", parsed: parse(p.text), confidence: Math.max(0.3, Math.min(0.9, p.confidence || 0.6)) });
    }
    // the merged result of all passes is what the reader returned; count it only when there were no passes (older reader)
    if (!out.length) out.push({ provider: "tesseract", kind: "local", model: "tesseract", parsed: r, confidence: r.confidence === "high" ? 0.85 : r.confidence === "medium" ? 0.7 : 0.5 });
    return out;
  }

  const FIELD_TO_R = { issueDate: "date", total: "total", amount10: "amount_10", amount8: "amount_8", amount0: "amount_other", merchantName: "vendor", invoiceRegistrationNumber: "invoice_no" };

  /**
   * Merge readings: consensus for key fields, the base (items, lines, notes) from the reading that agrees most.
   * @param {Array<{ provider: string, kind: string, parsed: any, confidence: number, result?: any }>} readings
   */
  function combine(readings) {
    const cons = P.consensus(readings.flatMap((rd) => P.candidates(rd)));
    const agree = (rd) => Object.entries(cons).filter(([f, c]) => P.norm(f, (rd.parsed || {})[FIELD_TO_R[f]] ?? (rd.parsed || {})[f]) === P.norm(f, c.value)).length;
    const kindRank = { vision: 3, text: 2, local: 1 };
    const base = readings.slice().sort((a, b) => agree(b) - agree(a) || (kindRank[b.kind] || 0) - (kindRank[a.kind] || 0))[0];
    const r = { ...((base && (base.result || base.parsed)) || {}) };
    for (const [f, c] of Object.entries(cons)) {
      const k = FIELD_TO_R[f]; if (!k) continue;
      r[k] = /^(total|amount)/.test(f) ? P.norm(f, c.value) : f === "issueDate" ? P.norm(f, c.value) : c.value;
    }
    // amounts must stay consistent with the chosen total: when the base's 10/8/0 split does not add up, keep it 10%
    if (r.total && (Number(r.amount_10) || 0) + (Number(r.amount_8) || 0) + (Number(r.amount_other) || 0) !== r.total && !(r.lines && r.lines.length)) {
      const a8 = Number(r.amount_8) || 0, a0 = Number(r.amount_other) || 0;
      r.amount_10 = Math.max(0, r.total - a8 - a0);
    }
    const conflicts = Object.entries(cons).filter(([, c]) => c.conflict).map(([f]) => f);
    return { r, consensus: cons, base: base ? base.provider : null, conflicts };
  }

  /**
   * Run the pipeline.
   * @param {{ mode: "local" | "auto" | "ai", local?: () => Promise<any>, text?: () => Promise<any> | null, vision?: () => Promise<any>, parse: (t: string) => any }} o
   *   local(): ReceiptOCR result · text(): parsed PDF text result or null · vision(): /api/scan result
   */
  async function run(o) {
    const readings = /** @type {any[]} */ ([]), log = [];
    if (o.text) {
      const t = await o.text();
      if (t) { readings.push({ provider: "pdf-text", kind: "text", model: "pdf.js", parsed: t, result: t, confidence: 0.95 }); log.push("pdf-text"); }
    }
    let localResult = null;
    let localError = null;
    if (o.mode !== "ai" && o.local && !readings.some((r) => r.kind === "text")) {
      // on-device OCR can fail (engine download, memory): with a vision provider the pipeline carries on without it
      try {
        localResult = await o.local();
        readings.push(...localReadings(localResult, o.parse).map((rd) => ({ ...rd, result: localResult })));
        log.push("local");
      } catch (e) {
        if (!(o.vision && o.mode === "auto")) throw e;
        localError = e; log.push("local-failed");
      }
    }
    let visionResult = null, why = null;
    if (o.vision && (o.mode === "ai" || o.mode === "auto")) {
      const cons = readings.length ? P.consensus(readings.flatMap((rd) => P.candidates(rd))) : {};
      why = o.mode === "ai" ? { ask: true, reasons: ["mode:ai"] } : P.needsVision(cons);
      if (why.ask) {
        try {
          visionResult = await o.vision();
          const meta = visionResult._meta || {};
          readings.push({ provider: "vision", kind: "vision", model: meta.model || "", promptVersion: meta.promptVersion || "", parsed: visionResult, result: visionResult,
            confidence: visionResult.confidence === "high" ? 0.9 : visionResult.confidence === "medium" ? 0.75 : 0.5 });
          log.push("vision");
        } catch (e) {
          if (!readings.length) throw e;          // nothing else to fall back on
          log.push("vision-failed");
        }
      }
    }
    if (!readings.length) throw localError || Object.assign(new Error("no reading"), { code: "ocr" });
    const c = combine(readings);
    // the local OCR words / passes stay with the result (bounding boxes for the review screen)
    if (localResult && localResult.ocr) c.r.ocr = localResult.ocr;
    c.r.readings = readings.map((rd) => ({ provider: rd.provider, kind: rd.kind, model: rd.model || "", promptVersion: rd.promptVersion || "", confidence: rd.confidence }));
    c.r.consensus = c.consensus;
    c.r.conflicts = c.conflicts;
    c.r.visionAsked = why;
    c.r.pipeline = log;
    return c.r;
  }

  const api = { localReadings, combine, run };
  if (isNode) module.exports = api;
  else root.DocPipeline = api;
})(typeof window !== "undefined" ? window : globalThis);
