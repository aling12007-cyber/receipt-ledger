// Receipt Ledger — Document Intelligence: low-confidence fields are read again, one field at a time.
//   low field with a box → crop · enlarge · enhance · OCR again (single line) → vision check of the crop (optional)
//   → rule validation decides between differing values. The whole page is never read again for one field.
// Readers are passed in (browser: ReceiptOCR.readRegion, /api/scan field mode), so the logic is testable.
// Exposes window.DocReverify (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const D = isNode ? require("./digits.js") : root.DocDigits;
  const V = isNode ? require("./validate.js") : root.DocValidate;
  /* eslint-enable no-undef */

  const AMOUNT = new Set(["total", "subtotal", "taxTotal"]);
  const FIELDS = ["total", "subtotal", "taxTotal", "issueDate", "invoiceRegistrationNumber"];
  /** @param {string} field @param {any} raw @param {number} [year] */
  function parseValue(field, raw, year) {
    if (raw == null) return null;
    if (AMOUNT.has(field)) { if (typeof raw === "number") return raw; const as = D.amountsIn(String(raw)); return as.length ? as[as.length - 1].value : null; }
    if (field === "issueDate") return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? String(raw) : D.date(String(raw), year).value;
    if (field === "invoiceRegistrationNumber") { const m = String(raw).toUpperCase().replace(/[\s-]/g, "").match(/T\d{13}/); return m ? m[0] : null; }
    return raw;
  }
  const errorsWith = (e, field, value, o) => {
    const copy = { ...e, [field]: { ...e[field], value } };
    return V.validate(copy, o).checks.filter((c) => c.level === "error" && c.fields.includes(field)).length;
  };

  /**
   * @param {any} e Extraction (a changed copy is returned)
   * @param {{ fields: Record<string, { level: string }> }} conf DocConfidence.score() result
   * @param {{ readRegion?: (bbox: any, o: any) => Promise<{ text: string, confidence: number }>, vision?: (field: string, bbox: any, ocrValue: any) => Promise<{ value: any, legible?: boolean, confidence?: string }>,
   *   year?: number, today?: string, maxFields?: number }} o
   */
  async function reverify(e, conf, o) {
    const out = JSON.parse(JSON.stringify(e)), log = [];
    const vo = { year: o.year, today: o.today };
    const todo = FIELDS.filter((f) => conf.fields[f] && conf.fields[f].level === "low" && out[f] && out[f].bbox).slice(0, o.maxFields ?? 3);
    for (const f of todo) {
      const cur = out[f].value, entry = { field: f, before: cur, beforeConfidence: out[f].confidence, reread: null, vision: null, outcome: "unchanged" };
      // 1) OCR again on the enlarged crop. When the line labelled for this field (e.g. 合計) disagreed with the chosen value,
      //    that labelled line is the one read again.
      const labelled = (out[f].alternatives || []).find((a) => a.source === "total-label" && a.bbox);
      if (o.readRegion) {
        try {
          const rr = await o.readRegion(labelled ? labelled.bbox : out[f].bbox, { digits: AMOUNT.has(f) });
          const val = parseValue(f, rr.text, o.year);
          entry.reread = { text: rr.text, value: val, confidence: rr.confidence, region: labelled ? "labelled-line" : "value-line" };
          // the arithmetic decides among: current value, the re-read, and the labelled line's first reading
          const cands = [...new Set([cur, val, ...(out[f].alternatives || []).map((a) => a.value)].filter((x) => x != null))];
          const score = (x) => errorsWith(out, f, x, vo);
          const best = cands.length ? cands.reduce((a, b) => (score(b) < score(a) ? b : a)) : null;
          if (val != null && val === cur && score(cur) === 0) { out[f].confidence = Math.max(out[f].confidence, 0.9); entry.outcome = "reread-agreed"; }
          else if (best != null && best !== cur && cur != null && score(best) < score(cur)) {
            out[f].value = best; out[f].confidence = best === val ? 0.8 : 0.7; out[f].corrected = [...(out[f].corrected || []), "reread"]; entry.outcome = "reread-fixed";
            if (labelled && (best === val || best === labelled.value)) out[f].bbox = labelled.bbox;   // the value now comes from the labelled line
            delete out[f].alternatives;
          } else if (val != null && cur == null) { out[f].value = val; out[f].confidence = Math.min(0.75, rr.confidence); entry.outcome = "reread-filled"; }
          else if (val != null && val === cur) { out[f].confidence = Math.max(out[f].confidence, 0.85); entry.outcome = "reread-agreed"; }
          else if (val != null) { out[f].confidence = Math.min(out[f].confidence, 0.5); entry.outcome = "reread-differs"; out[f].alternatives = [...(out[f].alternatives || []), { value: val, source: "reread" }]; }
        } catch (err) { entry.reread = { error: String(err && err.message || err) }; }
      }
      // 2) still doubtful: ask the vision model about this crop only
      if (o.vision && !/agreed|fixed/.test(entry.outcome)) {
        try {
          const vr = await o.vision(f, out[f].bbox, out[f].value);
          const val = vr && vr.legible !== false ? parseValue(f, vr.value, o.year) : null;
          entry.vision = { value: val, legible: vr ? vr.legible !== false : false, confidence: vr && vr.confidence };
          if (val != null && val === out[f].value) { out[f].confidence = Math.max(out[f].confidence, 0.95); entry.outcome = "vision-agreed"; delete out[f].alternatives; }
          else if (val != null && (out[f].value == null || errorsWith(out, f, val, vo) < errorsWith(out, f, out[f].value, vo))) {
            out[f].value = val; out[f].confidence = 0.85; out[f].corrected = [...(out[f].corrected || []), "vision"]; entry.outcome = "vision-fixed";
          } else if (val != null) { out[f].confidence = Math.min(out[f].confidence, 0.5); out[f].alternatives = [...(out[f].alternatives || []), { value: val, source: "vision" }]; entry.outcome = "conflict"; }
        } catch (err) { entry.vision = { error: String(err && err.message || err) }; }
      }
      entry.after = out[f].value; entry.afterConfidence = out[f].confidence;
      log.push(entry);
    }
    return { extraction: out, log };
  }

  const api = { reverify, parseValue, FIELDS };
  if (isNode) module.exports = api;
  else root.DocReverify = api;
})(typeof window !== "undefined" ? window : globalThis);
