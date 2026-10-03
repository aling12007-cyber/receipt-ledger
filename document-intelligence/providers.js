// Receipt Ledger — Document Intelligence: OCR provider abstraction and ensemble (consensus) of several readings.
//   interface OcrProvider { id, kind: "local" | "text" | "vision", model, weight, available(): boolean, extract(input, opts): Promise<Reading> }
//   Reading = { provider, model, promptVersion, ocr: OcrResult | null, parsed: <receipt fields>, confidence: 0–1 }
// Business logic never calls a provider directly: it asks the registry, and readings are compared field by field.
// Exposes window.DocProviders (and module.exports for tests).
(function (root) {
  /** Relative trust per provider kind (config). A PDF text layer is exact; local OCR can misread digits; vision models can invent. */
  const CONFIG = {
    weight: { text: 1.0, local: 0.6, vision: 0.8 },
    conflictRatio: 0.5,     // a different value with at least half the winner's weight is a conflict
    high: 0.95, medium: 0.8, // confidence levels (same as the Confidence Engine)
  };

  // ---- registry ----
  /** @type {Map<string, any>} */
  const registry = new Map();
  /** @param {{ id: string, kind: string, model?: string, available?: () => boolean, extract: (input: any, opts?: any) => Promise<any> }} p */
  function register(p) {
    if (!p || !p.id || typeof p.extract !== "function") throw new Error("an OCR provider needs id and extract()");
    registry.set(p.id, { available: () => true, model: "", ...p });
    return p.id;
  }
  const get = (id) => registry.get(id) || null;
  const list = () => [...registry.values()];
  const available = (kind) => list().filter((p) => (!kind || p.kind === kind) && p.available());
  const clear = () => registry.clear();

  // ---- field normalization (so "¥1,100" and 1100, "2026/9/28" and "2026-09-28" compare equal) ----
  const KEY_FIELDS = ["issueDate", "total", "amount10", "amount8", "amount0", "merchantName", "invoiceRegistrationNumber"];
  /** @param {string} field @param {any} v */
  function norm(field, v) {
    if (v == null || v === "") return null;
    if (/^(total|amount10|amount8|amount0|subtotal|taxTotal|discount)$/.test(field)) {
      const m = typeof v === "number" ? null : String(v).replace(/[,，\s]/g, "").match(/-?\d+(\.\d+)?/);
      const n = typeof v === "number" ? v : m ? Number(m[0]) : NaN;
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    if (field === "issueDate") {
      const m = String(v).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
      return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
    }
    if (field === "invoiceRegistrationNumber") { const m = String(v).toUpperCase().replace(/[\s-]/g, "").match(/T\d{13}/); return m ? m[0] : null; }
    if (field === "merchantName") return String(v).replace(/株式会社|有限会社|合同会社|[（(]\s*[株有]\s*[)）]|\s|・/g, "").toLowerCase() || null;
    return String(v);
  }

  /**
   * Field candidates from one reading. parsed uses the receipt-reader shape (date, total, amount_10 …) or the extraction shape.
   * @param {{ provider: string, kind?: string, parsed: any, confidence?: number, fieldConfidence?: Record<string, number> }} reading
   */
  function candidates(reading) {
    const p = reading.parsed || {};
    const val = {
      issueDate: p.issueDate ?? p.date, total: p.total, amount10: p.amount10 ?? p.amount_10, amount8: p.amount8 ?? p.amount_8, amount0: p.amount0 ?? p.amount_other,
      merchantName: p.merchantName ?? p.vendor, invoiceRegistrationNumber: p.invoiceRegistrationNumber ?? p.invoice_no,
    };
    const base = reading.confidence ?? 0.7;
    return KEY_FIELDS.filter((f) => norm(f, val[f]) != null && !(/^amount/.test(f) && !norm(f, val[f])))
      .map((f) => ({ field: f, value: val[f], key: norm(f, val[f]), provider: reading.provider, kind: reading.kind || "local",
        confidence: (reading.fieldConfidence && reading.fieldConfidence[f]) ?? base }));
  }

  /**
   * Consensus per field. Equal values add up their weight × confidence; the heaviest value wins.
   * agreement = winner's share of all weight; conflict when another value has at least conflictRatio of the winner's weight.
   * @param {Array<ReturnType<typeof candidates>[number]>} cands
   * @param {Partial<typeof CONFIG>} [cfg]
   */
  function consensus(cands, cfg = {}) {
    const C = { ...CONFIG, ...cfg, weight: { ...CONFIG.weight, ...(cfg.weight || {}) } };
    /** @type {Record<string, any>} */
    const out = {};
    const byField = new Map();
    for (const c of cands) { if (!byField.has(c.field)) byField.set(c.field, []); byField.get(c.field).push(c); }
    for (const [field, cs] of byField) {
      const groups = new Map();
      for (const c of cs) {
        const g = groups.get(c.key) || { key: c.key, value: c.value, weight: 0, providers: [], best: 0 };
        const w = (C.weight[c.kind] ?? 0.5) * c.confidence;
        g.weight += w; g.providers.push(c.provider);
        if (w > g.best) { g.best = w; g.value = c.value; }
        groups.set(c.key, g);
      }
      const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight);
      const total = ranked.reduce((s, g) => s + g.weight, 0), win = ranked[0], second = ranked[1];
      const agreement = total ? win.weight / total : 0;
      const conflict = !!second && second.weight >= win.weight * C.conflictRatio;
      // independent providers that agree raise confidence; a single reading keeps its own
      // passes of the same engine (tesseract:standard / tesseract:full) are not independent readers
      const engine = (p) => String(p).split(":")[0];
      const agreeing = new Set(win.providers.map(engine)).size, readers = new Set(cs.map((c) => engine(c.provider))).size;
      const top = Math.max(...cs.filter((c) => c.key === win.key).map((c) => c.confidence));
      let confidence = agreeing >= 2 ? 1 - (1 - top) * Math.pow(0.5, agreeing - 1) : top;
      if (readers > agreeing) confidence *= agreement;
      if (conflict) confidence = Math.min(confidence, 0.6);
      out[field] = { value: win.value, confidence: Math.round(confidence * 1000) / 1000, agreement: Math.round(agreement * 1000) / 1000, providers: win.providers, conflict,
        alternatives: ranked.slice(1).map((g) => ({ value: g.value, providers: g.providers })) };
    }
    return out;
  }

  /** @param {number} c @param {Partial<typeof CONFIG>} [cfg] */
  const level = (c, cfg = {}) => { const C = { ...CONFIG, ...cfg }; return c >= C.high ? "high" : c >= C.medium ? "medium" : "low"; };

  /**
   * Should the expensive provider be asked? Only when a key field is missing, uncertain or in conflict (cheap first).
   * @param {Record<string, any>} cons consensus() result @param {{ minConfidence?: number }} [o]
   */
  function needsVision(cons, o = {}) {
    const min = o.minConfidence ?? CONFIG.medium;
    const reasons = [];
    for (const f of ["issueDate", "total", "merchantName"]) {
      const c = cons[f];
      if (!c) reasons.push(f + ":missing");
      else if (c.conflict) reasons.push(f + ":conflict");
      else if (c.confidence < min) reasons.push(f + ":low");
    }
    return { ask: reasons.length > 0, reasons };
  }

  const api = { CONFIG, register, get, list, available, clear, KEY_FIELDS, norm, candidates, consensus, level, needsVision };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocProviders = api;
})(typeof window !== "undefined" ? window : globalThis);
