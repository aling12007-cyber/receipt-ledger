// Receipt Ledger — keeps the new journal in step with the old "entries" rows while the screens still edit them.
// New row → posted entry; changed row → reversal of the old entry + corrected entry; deleted row → reversal.
// Nothing in the journal is ever changed or deleted. Exposes window.Sync (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Migrate = isNode ? require("./migrate.js") : root.Migrate;
  /* eslint-enable no-undef */

  const base = (k) => String(k).split("#")[0];
  const lineKey = (l) => [l.account, +l.dr, +l.cr, l.tax_code, +l.tax_amount].join("|");
  const sameLines = (a, b) => JSON.stringify(a.map(lineKey).sort()) === JSON.stringify(b.map(lineKey).sort());
  // short, stable signature of an entry's content (keeps a re-run from posting the same correction twice)
  function sig(e) {
    let h = 5381;
    for (const ch of e.date + "|" + e.lines.map(lineKey).sort().join(";")) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }

  /**
   * @param {any[]} rows old entries rows
   * @param {any} settings
   * @param {{ entries: any[], map: Array<{ legacy_id: string, journal_entry_id: string }> }} db journal entries with lines + legacy_map
   * @param {{ Books: any, Filing: any, uuid?: () => string }} deps
   */
  function plan(rows, settings, db, deps) {
    const uuid = deps.uuid || (() => root.crypto.randomUUID());
    const target = Migrate.plan(rows, settings, deps);
    const reversed = new Set(db.entries.filter((e) => e.kind === "reversal" && e.status === "posted").map((e) => e.reverses));
    const keysOf = new Map();
    for (const m of db.map) { if (!keysOf.has(m.journal_entry_id)) keysOf.set(m.journal_entry_id, []); keysOf.get(m.journal_entry_id).push(m.legacy_id); }
    const active = db.entries.filter((e) => e.source === "migrated" && e.status === "posted" && e.kind !== "reversal" && !reversed.has(e.id) && keysOf.has(e.id));
    const out = [], counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    const reversal = (a, why) => ({
      id: uuid(), legacy_ids: ["rev:" + a.id], date: a.date, kind: "reversal", reverses: a.id, source: "migrated",
      vendor: a.vendor || "", invoice_no: a.invoice_no || "", invoice_status: a.invoice_status ?? null, memo: "取消（" + why + "）：" + (a.memo || ""),
      rule_version: a.rule_version || "2026.1", transaction: null,
      lines: a.lines.map((l) => ({ account: l.account, dr: +l.cr, cr: +l.dr, tax_code: l.tax_code, tax_amount: +l.tax_amount })),
    });
    const used = new Set();
    for (const p of target.entries) {
      const bases = new Set(p.legacy_ids.map(base));
      const mine = active.filter((a) => keysOf.get(a.id).some((k) => bases.has(base(k))));
      mine.forEach((a) => used.add(a.id));
      if (mine.length === 1 && mine[0].date === p.date && sameLines(mine[0].lines, p.lines)) { counts.unchanged++; continue; }
      for (const a of mine) out.push(reversal(a, "元データ変更"));
      const history = db.map.filter((m) => bases.has(base(m.legacy_id))).length;
      out.push(history ? { ...p, legacy_ids: p.legacy_ids.map((k) => k + "#" + sig(p) + "." + history) } : p);
      if (history) counts.changed++; else counts.added++;
    }
    for (const a of active) if (!used.has(a.id)) { out.push(reversal(a, "元データ削除")); counts.removed++; }
    return { payload: { documents: target.documents, entries: out, fixed_assets: target.fixed_assets, fiscal_years: target.fiscal_years }, target, counts };
  }

  // net balance per "year account" key
  function balances(entries) {
    const tb = {};
    for (const e of entries) for (const l of e.lines) { const k = String(e.date).slice(0, 4) + " " + l.account; tb[k] = (tb[k] || 0) + Number(l.dr) - Number(l.cr); }
    for (const k of Object.keys(tb)) if (!tb[k]) delete tb[k];
    return tb;
  }
  /** Differences between two balance maps. */
  function diff(a, b) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] || 0) !== (b[k] || 0)).map((k) => ({ key: k, books: a[k] || 0, records: b[k] || 0 }));
  }

  /** Load the migrated part of the journal and the legacy map. */
  async function load(sb) {
    const entries = [], map = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("journal_entries").select("id,date,kind,status,source,reverses,vendor,invoice_no,invoice_status,memo,rule_version,journal_lines(account,dr,cr,tax_code,tax_amount)")
        .eq("source", "migrated").neq("status", "void").range(from, from + 999);
      if (r.error) throw r.error;
      entries.push(...r.data.map((e) => ({ ...e, lines: e.journal_lines || [] })));
      if (r.data.length < 1000) break;
    }
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("legacy_map").select("legacy_id,journal_entry_id").range(from, from + 999);
      if (r.error) throw r.error;
      map.push(...r.data);
      if (r.data.length < 1000) break;
    }
    return { entries, map };
  }

  /**
   * Bring the journal in step with the old rows, then prove it: the migrated journal's balance per account and
   * year must equal what the old rows say. Returns { counts, ok, diffs }.
   */
  async function run(sb, rows, settings, deps) {
    const v = await sb.rpc("accounting_core_version");
    if (v.error || !(v.data >= 2)) throw Object.assign(new Error("accounting core SQL is out of date"), { code: "SQL_OUTDATED" });
    const before = await load(sb);
    const p = plan(rows, settings, before, deps);
    if (p.payload.entries.length || p.payload.fiscal_years.length) {
      const { error } = await sb.rpc("import_journal", { payload: p.payload });
      if (error) throw Object.assign(new Error(error.message), { code: "DB" });
    }
    const after = p.payload.entries.length ? await load(sb) : before;
    const want = balances(p.target.entries);
    const d = diff(balances(after.entries.filter((e) => e.status === "posted")), want);
    return { counts: p.counts, ok: d.length === 0, diffs: d, balances: Object.keys(want).length };
  }

  const api = { plan, run, load, balances, diff, sig };
  if (isNode) module.exports = api;
  else root.Sync = api;
})(typeof window !== "undefined" ? window : globalThis);
