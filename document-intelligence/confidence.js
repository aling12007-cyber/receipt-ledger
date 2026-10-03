// Receipt Ledger — Document Intelligence: field-level confidence.
// Combines the OCR line confidence, corrected characters, agreement between readers (ensemble), digits OCR
// often swaps, and the validation result. OCR confidence alone is never taken as accounting correctness:
// a field in a failed check is low whatever the OCR said.
// Exposes window.DocConfidence (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const D = isNode ? require("./digits.js") : root.DocDigits;
  const P = isNode ? require("./providers.js") : root.DocProviders;
  /* eslint-enable no-undef */

  /** Thresholds (config): ≥ high → High, ≥ medium → Medium, below → Low. */
  const CONFIG = { high: 0.95, medium: 0.8, conflictCap: 0.6, errorCap: 0.5, warningFactor: 0.9, swapFactor: 0.95, crossChecked: 0.92 };
  const FIELDS = { issueDate: "issueDate", merchantName: "merchantName", subtotal: "subtotal", taxTotal: "taxTotal", total: "total", invoiceRegistrationNumber: "invoiceRegistrationNumber", paymentMethod: "paymentMethod" };
  const KEY = ["issueDate", "merchantName", "total"];
  const NUMERIC = new Set(["subtotal", "taxTotal", "total"]);

  /** @param {number} s @param {Partial<typeof CONFIG>} [cfg] */
  const level = (s, cfg = {}) => { const C = { ...CONFIG, ...cfg }; return s >= C.high ? "high" : s >= C.medium ? "medium" : "low"; };

  /**
   * @param {any} e Extraction
   * @param {{ consensus?: Record<string, any>, validation?: { checks: any[] }, account?: { account: string, confidence: number, source?: string } | null, config?: Partial<typeof CONFIG> }} [o]
   */
  function score(e, o = {}) {
    const C = { ...CONFIG, ...(o.config || {}) };
    /** @type {Record<string, { score: number, level: string, reasons: string[], value: any }>} */
    const fields = {};
    const checks = (o.validation && o.validation.checks) || [];
    const fieldNames = { ...FIELDS, taxRate: "taxBreakdown" };
    for (const [name, key] of Object.entries(fieldNames)) {
      const reasons = [];
      let s, value;
      if (name === "taxRate") {
        const bd = e.taxBreakdown || [];
        if (!bd.length) continue;
        s = Math.min(...bd.map((b) => b.confidence ?? 0.5));
        value = bd.map((b) => b.rate + "%").join(" / ");
        if (bd.every((b) => b.source === "derived")) reasons.push("derived");
      } else {
        const f = e[key];
        if (!f) continue;
        value = f.value;
        s = value == null || value === "" ? 0 : f.confidence;
        if (value == null || value === "") reasons.push("missing");
        if (f.corrected && f.corrected.length) reasons.push("corrected");
      }
      // agreement between readers
      const c = o.consensus && o.consensus[name];
      if (c && value != null && value !== "") {
        const same = P.norm(name, c.value) === P.norm(name, value);
        if (c.conflict) { s = Math.min(s, C.conflictCap); reasons.push("conflict"); }
        else if (same && c.providers && new Set(c.providers.map((x) => String(x).split(":")[0])).size >= 2) { s = Math.max(s, c.confidence); reasons.push("agreed"); }
        else if (!same) { s = Math.min(s, C.conflictCap); reasons.push("readers-differ"); }
      }
      // digits OCR often confuses (0/6/8, 3/8, 1/7, 5/6) on a line read with less than full confidence
      if (NUMERIC.has(name) && value != null && D.swappable(value) && s < 0.97 && s > 0) { s *= C.swapFactor; reasons.push("swappable-digits"); }
      // validation decides over OCR confidence
      const mine = checks.filter((k) => k.fields.includes(key) || (name === "taxRate" && k.fields.includes("taxBreakdown")));
      if (mine.some((k) => k.level === "error")) { s = Math.min(s, C.errorCap); reasons.push("validation-error"); }
      else if (mine.some((k) => k.level === "warning")) { s *= C.warningFactor; reasons.push("validation-warning"); }
      else if (mine.filter((k) => k.level === "ok").length >= 2 && s > 0 && !reasons.includes("conflict") && !reasons.includes("readers-differ")) { s = Math.max(s, C.crossChecked); reasons.push("cross-checked"); }   // independent sums agree
      else if (mine.some((k) => k.level === "ok") && s > 0) { s = Math.min(1, s + 0.03); reasons.push("validated"); }
      s = Math.round(Math.max(0, Math.min(1, s)) * 1000) / 1000;
      fields[name] = { score: s, level: level(s, C), reasons, value };
    }
    // the recommended account is part of what gets booked: a weak recommendation means a person decides
    if (o.account && o.account.account) {
      const s2 = Math.round(Math.max(0, Math.min(1, o.account.confidence || 0)) * 1000) / 1000;
      fields.account = { score: s2, level: level(s2, C), reasons: [o.account.source || "suggestion"], value: o.account.account };
    }
    const keyScores = KEY.map((k) => (fields[k] ? fields[k].score : 0));
    const overall = Math.min(...keyScores);
    const low = Object.entries(fields).filter(([k, f]) => f.level === "low" && (KEY.includes(k) || f.value != null)).map(([k]) => k);
    const needsReview = overall < C.medium || low.length > 0 || checks.some((k) => k.level === "error");
    return { fields, overall: Math.round(overall * 1000) / 1000, level: level(overall, C), needsReview, lowFields: low, status: needsReview ? "needs_review" : "ai_suggested" };
  }

  const api = { CONFIG, level, score };
  if (isNode) module.exports = api;
  else root.DocConfidence = api;
})(typeof window !== "undefined" ? window : globalThis);
