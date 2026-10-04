// Receipt Ledger — .receiptledger backup: one JSON file with the records, settings and merchant knowledge.
// Receipt images stay in storage (the records keep their paths). The journal is rebuilt from the records by the sync,
// so it is not stored twice. A checksum catches a damaged or hand-edited file before anything is restored.
// Exposes window.Backup (and module.exports for tests).
(function (root) {
  const FORMAT = "receiptledger", VERSION = 1;
  const ENTRY_KEYS = ["id", "type", "date", "vendor", "invoiceNo", "items", "amt10", "amt8", "amt0", "debit", "credit", "bizRatio", "memo", "aiConfidence", "assetId"];

  /** FNV-1a (32 bit) of a string, hex. @param {string} s */
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }
  /** Only the fields a record is made of (drops UI-only state). @param {any} e */
  function cleanEntry(e) {
    const o = {};
    for (const k of ENTRY_KEYS) if (e[k] !== undefined && e[k] !== null) o[k] = e[k];
    return o;
  }
  const body = (b) => JSON.stringify({ entries: b.entries, settings: b.settings, knowledge: b.knowledge });

  /**
   * @param {{ entries: any[], settings: any, knowledge?: any[], exportedAt?: string }} o
   */
  function make(o) {
    const b = {
      format: FORMAT, version: VERSION, exportedAt: o.exportedAt || new Date().toISOString(),
      entries: (o.entries || []).map(cleanEntry).sort((a, b2) => String(a.date).localeCompare(String(b2.date)) || String(a.id).localeCompare(String(b2.id))),
      settings: o.settings || {}, knowledge: (o.knowledge || []).map((k) => ({ merchant: k.merchant, account: k.account, uses: k.uses || 1, raw_names: k.raw_names || [] })),
    };
    return { ...b, counts: { entries: b.entries.length, knowledge: b.knowledge.length }, checksum: hash(body(b)) };
  }
  /** @param {string} name @param {string} [date] */
  const fileName = (name, date) => `${(String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_") || "aoiro").slice(0, 40)}_${(date || new Date().toISOString()).slice(0, 10)}.receiptledger`;

  /** @param {string} text @returns {{ ok: boolean, errors: string[], data: any }} */
  function parse(text) {
    const errors = [];
    let d = null;
    try { d = JSON.parse(String(text || "").replace(/^﻿/, "")); } catch (e) { return { ok: false, errors: ["notJson"], data: null }; }
    if (!d || d.format !== FORMAT) errors.push("notBackup");
    else if (!(d.version >= 1) || d.version > VERSION) errors.push("newerVersion");
    if (!errors.length) {
      if (!Array.isArray(d.entries)) errors.push("noEntries");
      else {
        if (d.checksum !== hash(body({ entries: d.entries, settings: d.settings || {}, knowledge: d.knowledge || [] }))) errors.push("checksum");
        const bad = d.entries.filter((e) => !e || !e.id || !/^(expense|income)$/.test(e.type) || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) || !e.debit || !e.credit);
        if (bad.length) errors.push("badEntries");
      }
    }
    if (errors.length) return { ok: false, errors, data: null };
    return { ok: true, errors, data: { ...d, settings: d.settings || {}, knowledge: d.knowledge || [] } };
  }

  /**
   * What restoring would change. Records are matched by id: new ones are added, changed ones replaced; nothing is deleted.
   * @param {any} data parsed backup @param {any[]} current current records
   */
  function plan(data, current) {
    const byId = new Map((current || []).map((e) => [e.id, JSON.stringify(cleanEntry(e))]));
    const add = [], update = [];
    let same = 0;
    for (const e of data.entries) {
      const cur = byId.get(e.id);
      if (cur === undefined) add.push(e);
      else if (cur !== JSON.stringify(cleanEntry(e))) update.push(e);
      else same++;
    }
    const years = [...new Set(data.entries.map((e) => String(e.date).slice(0, 4)))].sort();
    return { add, update, same, years, keepOnly: (current || []).filter((e) => !data.entries.some((x) => x.id === e.id)).length };
  }

  const api = { FORMAT, VERSION, hash, make, parse, plan, fileName, cleanEntry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Backup = api;
})(typeof window !== "undefined" ? window : globalThis);
