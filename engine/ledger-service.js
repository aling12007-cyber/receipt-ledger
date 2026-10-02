// Receipt Ledger — LedgerService: the only place the screens read or write journal entries.
// Wraps the Supabase client; checks every entry with the Journal Engine before sending it; posting goes
// through public.import_journal, so one entry (with its lines, transaction and document) is written atomically.
// Exposes window.LedgerService (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Journal = isNode ? require("./journal.js") : root.Journal;
  /* eslint-enable no-undef */

  /**
   * @param {any} sb Supabase client
   * @param {{ uuid?: () => string }} [opts]
   */
  function create(sb, opts = {}) {
    const uuid = opts.uuid || (() => root.crypto.randomUUID());
    let available = null;

    /** Are the accounting-core tables there (002_accounting_core.sql has been run)? */
    async function isAvailable() {
      if (available !== null) return available;
      const r = await sb.from("journal_entries").select("id", { count: "exact", head: true });
      available = !r.error;
      return available;
    }

    /**
     * Post one entry. `key` makes a retry (double click, network error) post it only once.
     * @param {JournalEntry} entry
     * @param {{ key?: string, transaction?: object, documentPath?: string, source?: string }} [o]
     */
    async function post(entry, o = {}) {
      const v = Journal.validate(entry);
      if (!v.ok) throw Object.assign(new Error("journal entry is not valid"), { code: "INVALID", errors: v.errors });
      const id = uuid();
      const payload = {
        documents: o.documentPath ? [{ storage_path: o.documentPath, mime_type: /\.pdf$/i.test(o.documentPath) ? "application/pdf" : "image/jpeg", source: "upload" }] : [],
        entries: [{
          id, legacy_ids: ["app:" + (o.key || id)], date: entry.date, kind: entry.kind, source: o.source || "manual", vendor: entry.vendor || "",
          invoice_no: entry.invoice_no || "", invoice_status: entry.invoice_status ?? null, memo: entry.memo || "", rule_version: entry.rule_version,
          reverses: entry.reverses ?? null,
          transaction: o.transaction || (o.documentPath ? { document_path: o.documentPath, date: entry.date, vendor: entry.vendor || "", status: "confirmed", source: o.source || "manual" } : null),
          lines: entry.lines,
        }],
      };
      const { data, error } = await sb.rpc("import_journal", { payload });
      if (error) throw Object.assign(new Error(error.message), { code: "DB" });
      return { id, posted: data.posted === 1, duplicate: data.skipped === 1 };
    }

    /** Entries of a year with their lines, posted and draft (void ones left out). @param {number} year */
    async function list(year) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("journal_entries")
          .select("id,date,kind,status,source,vendor,invoice_no,invoice_status,memo,reverses,rule_version,transaction_id,journal_lines(account,dr,cr,tax_code,tax_amount,memo,line_no),legacy_map(legacy_id),transactions(documents(storage_path))")
          .gte("date", year + "-01-01").lte("date", year + "-12-31").neq("status", "void")
          .order("date", { ascending: true }).range(from, from + 999);
        if (error) throw Object.assign(new Error(error.message), { code: "DB" });
        out.push(...data.map((e) => {
          const { journal_lines, legacy_map, transactions, ...rest } = e;
          return { ...rest, lines: (journal_lines || []).sort((a, b) => a.line_no - b.line_no),
            legacyIds: (legacy_map || []).map((m) => m.legacy_id), doc: (transactions && transactions.documents && transactions.documents.storage_path) || null };
        }));
        if (data.length < 1000) break;
      }
      return out;
    }

    /** Cancel a posted entry with a reversal entry (逆仕訳). @param {any} entry posted entry with id and lines @param {string} [date] */
    async function reverse(entry, date) {
      return post(Journal.reverse(entry, date), { key: "reverse:" + entry.id, source: "manual" });
    }
    /** 訂正: reversal of the old entry, then the corrected one. @param {any} old @param {any} fixed */
    async function correct(old, fixed) {
      const r = await reverse(old);
      const p = await post(fixed, { key: "correct:" + old.id });
      return { reversal: r, entry: p };
    }

    /** Delete an entry permanently (with its reversal pair); returns the storage paths of documents that went with it. @param {{ id: string }} entry */
    async function remove(entry) {
      const { data, error } = await sb.rpc("purge_journal", { ids: [entry.id] });
      if (error) throw Object.assign(new Error(error.message), { code: "DB" });
      return { removed: (data && data.entries) || 0, paths: (data && data.paths) || [] };
    }

    return { isAvailable, post, list, reverse, correct, remove };
  }

  const api = { create };
  if (isNode) module.exports = api;
  else root.LedgerService = api;
})(typeof window !== "undefined" ? window : globalThis);
