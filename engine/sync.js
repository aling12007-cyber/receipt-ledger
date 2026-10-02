// Receipt Ledger — keeps the new journal in step with the old "entries" rows while the screens still edit them.
// New row → posted entry; changed row → the old entry is deleted and the current version posted (no reversal);
// deleted row → its entries (with their reversals and corrections) are deleted permanently (purge_journal).
// Exposes window.Sync (and module.exports for tests).
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
    const target = Migrate.plan(rows, settings, deps);
    const keysOf = new Map();
    for (const m of db.map) { if (!keysOf.has(m.journal_entry_id)) keysOf.set(m.journal_entry_id, []); keysOf.get(m.journal_entry_id).push(m.legacy_id); }
    const migrated = db.entries.filter((e) => e.source === "migrated" && e.kind !== "reversal" && keysOf.has(e.id));
    const reversalsOf = (id) => db.entries.filter((e) => e.kind === "reversal" && e.reverses === id);
    const out = [], purge = new Set(), counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    // An edited row overwrites: every earlier version of it (and any reversal left by older app versions) is
    // deleted for good and only the current version is posted, so no old account stays in the books.
    for (const p of target.entries) {
      const bases = new Set(p.legacy_ids.map(base));
      const mine = migrated.filter((a) => keysOf.get(a.id).some((k) => bases.has(base(k))));
      const revs = mine.flatMap((a) => reversalsOf(a.id));
      if (mine.length === 1 && !revs.length && mine[0].status === "posted" && mine[0].date === p.date && sameLines(mine[0].lines, p.lines)) { counts.unchanged++; continue; }
      for (const a of mine) purge.add(a.id);
      for (const r of revs) purge.add(r.id);
      out.push(p);
      if (mine.length) counts.changed++; else counts.added++;
    }
    // Deleted rows: every migrated entry whose rows are all gone goes for good, with the reversals that point at it
    const wanted = new Set(target.entries.flatMap((p) => p.legacy_ids.map(base)));
    for (const e of migrated) {
      const keys = keysOf.get(e.id).map(base);
      if (!keys.some((k) => wanted.has(k)) && !purge.has(e.id)) { purge.add(e.id); counts.removed++; }
    }
    for (const e of db.entries) if (e.kind === "reversal" && purge.has(e.reverses)) purge.add(e.id);
    // reversals whose entry is already gone (nothing to cancel any more)
    const ids = new Set(db.entries.map((e) => e.id));
    for (const e of db.entries) if (e.source === "migrated" && e.kind === "reversal" && e.reverses && !ids.has(e.reverses)) purge.add(e.id);
    return { payload: { documents: target.documents, entries: out, fixed_assets: target.fixed_assets, fiscal_years: target.fiscal_years }, purge: [...purge], target, counts };
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
    if (v.error || !(v.data >= 3)) throw Object.assign(new Error("accounting core SQL is out of date"), { code: "SQL_OUTDATED" });
    const before = await load(sb);
    const p = plan(rows, settings, before, deps);
    let paths = [];
    if (p.purge.length) {
      const { data, error } = await sb.rpc("purge_journal", { ids: p.purge });
      if (error) throw Object.assign(new Error(error.message), { code: "DB" });
      paths = (data && data.paths) || [];
    }
    if (p.payload.entries.length || p.payload.fiscal_years.length) {
      const { error } = await sb.rpc("import_journal", { payload: p.payload });
      if (error) throw Object.assign(new Error(error.message), { code: "DB" });
    }
    const after = p.payload.entries.length || p.purge.length ? await load(sb) : before;
    const want = balances(p.target.entries);
    const d = diff(balances(after.entries.filter((e) => e.status === "posted")), want);
    return { counts: p.counts, ok: d.length === 0, diffs: d, balances: Object.keys(want).length, removedPaths: paths };
  }

  const api = { plan, run, load, balances, diff, sig };
  if (isNode) module.exports = api;
  else root.Sync = api;
})(typeof window !== "undefined" ? window : globalThis);
