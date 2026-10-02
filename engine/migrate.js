// Receipt Ledger — data upgrade: old "entries" rows (one row per receipt) → double-entry journal.
// Pure functions, no DOM, no network. Exposes window.Migrate (and module.exports for tests).
//
// plan(entries, settings, deps) builds the payload for the database function public.import_journal:
//   * rows that share one receipt image (the split lines of one receipt) become ONE compound entry
//   * each tax bucket becomes its own debit line with a 税区分 and tax amount (税込経理):
//       amt10 → P10 (S10 for sales), amt8 → P8 (S8), amt0 → PN for 非課税 accounts (家賃・保険・切手・利息), else PX (SX)
//   * the private share (家事按分) becomes a 事業主貸 line, exactly as the old screen showed it (books.js linesOf)
//   * fixed assets get an acquisition entry; opening balances (期首) become an opening entry with 元入金
// verify(entries, payload, deps) proves the new journal has the same balance per account and year as the old rows.
(function (root) {
  const NONTAX_PN = new Set(["地代家賃", "損害保険料", "通信費", "利子割引料"]); // amt0 on these = 非課税 (住宅家賃, 保険, 切手, 利息)
  const taxOf = (gross, code) => (code === "P10" || code === "S10" ? Math.floor(gross * 10 / 110) : code === "P8" || code === "S8" ? Math.floor(gross * 8 / 108) : 0);
  const isInvoice = (s) => /^T\d{13}$/.test(String(s || ""));
  const ymd = (d) => String(d || "").slice(0, 10);

  // lines of one old row: [{ account, dr, cr, tax_code, tax_amount }]
  function rowLines(e, Books) {
    const out = [];
    const add = (account, dr, cr, code) => { const amt = dr || cr; if (amt > 0) out.push({ account, dr, cr, tax_code: code, tax_amount: taxOf(amt, code) }); };
    const a10 = +e.amt10 || 0, a8 = +e.amt8 || 0, a0 = +e.amt0 || 0, total = Books.totalOf(e);
    if (e.type === "income") {
      add(e.debit || "普通預金", total, 0, "-");
      add("売上高", 0, a10, "S10"); add("売上高", 0, a8, "S8"); add("売上高", 0, a0, "SX");
      return out;
    }
    const r = Books.ratioOf(e), biz = Books.bizOf(e), credit = e.credit || "事業主借";
    let b10 = Math.round(a10 * r), b8 = Math.round(a8 * r), b0 = biz - b10 - b8;
    if (b0 !== 0 && a0 === 0) { if (b10 >= b8) b10 += b0; else b8 += b0; b0 = 0; } // rounding remainder stays in a taxed bucket
    add(e.debit, b10, 0, "P10"); add(e.debit, b8, 0, "P8"); add(e.debit, b0, 0, NONTAX_PN.has(e.debit) ? "PN" : "PX");
    if (credit === "事業主借") { add(credit, 0, biz, "-"); return out; } // private share paid privately: not booked
    if (total - biz > 0) add("事業主貸", total - biz, 0, "-");
    add(credit, 0, total, "-");
    return out;
  }

  // merge lines of several rows: debits first, then credits; same account + tax code added together
  function mergeLines(lines) {
    const map = new Map();
    for (const l of lines) {
      const side = l.dr ? "dr" : "cr", k = side + "|" + l.account + "|" + l.tax_code;
      const m = map.get(k);
      if (m) { m[side] += l[side]; m.tax_amount = taxOf(m[side], m.tax_code); } else map.set(k, { ...l });
    }
    const all = [...map.values()];
    return [...all.filter((l) => l.dr), ...all.filter((l) => l.cr)];
  }

  function plan(entries, settings, deps) {
    const { Books, Filing } = deps;
    const uuid = deps.uuid || (() => root.crypto.randomUUID());
    const s = settings || {};
    const warnings = [];
    const documents = new Map(), out = [];

    // 1) receipts → entries (split rows of one receipt merged)
    const groups = new Map();
    entries.forEach((e, i) => {
      if (!e || !e.date || Books.totalOf(e) <= 0) { warnings.push({ code: "SKIPPED_EMPTY", id: e && e.id }); return; }
      if (!e.id) e = { ...e, id: "row:" + i };
      const k = e.assetId ? [e.assetId, e.date, e.type, e.credit || "", e.type === "income" ? e.debit : ""].join("|") : "id:" + e.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    for (const rows of groups.values()) {
      const first = rows[0];
      if (first.assetId && !documents.has(first.assetId))
        documents.set(first.assetId, { storage_path: first.assetId, mime_type: /\.pdf$/i.test(first.assetId) ? "application/pdf" : "image/jpeg", source: "migrated" });
      const lines = mergeLines(rows.flatMap((e) => rowLines(e, Books)));
      const inv = (rows.find((e) => e.invoiceNo) || {}).invoiceNo || "";
      const memo = [...new Set(rows.map((e) => [e.items, e.memo].filter(Boolean).join(" ").replace(/\s*同一領収書 \d+\/\d+$/, "")).filter(Boolean))].join(" ／ ");
      out.push({
        id: uuid(), legacy_ids: rows.map((e) => e.id), date: ymd(first.date),
        kind: lines.length > 2 ? "compound" : "normal", source: "migrated",
        vendor: first.vendor || "", invoice_no: inv,
        invoice_status: first.type === "income" ? null : isInvoice(inv) ? "確認済" : "要確認",
        memo, rule_version: "2026.1",
        transaction: { id: uuid(), document_path: first.assetId || null, date: ymd(first.date), vendor: first.vendor || "", total: rows.reduce((t, e) => t + Books.totalOf(e), 0), payment: "unknown", status: "confirmed", source: "migrated" },
        lines,
      });
    }

    // 2) opening balances (期首) per year, and fixed assets
    const assets = (s.assets || []).filter((a) => a && a.date && +a.cost > 0);
    const bsYears = Object.keys(s.bs || {}).map(Number).filter((y) => y > 2000 && s.bs[y] && s.bs[y].open).sort();
    const firstOpen = bsYears[0];
    const n = (v) => Math.round(+v || 0);
    for (const y of bsYears) {
      const o = s.bs[y].open, L = [];
      const dr = (account, v) => { if (n(v) > 0) L.push({ account, dr: n(v), cr: 0, tax_code: "-", tax_amount: 0 }); else if (n(v) < 0) L.push({ account, dr: 0, cr: -n(v), tax_code: "-", tax_amount: 0 }); };
      const cr = (account, v) => dr(account, -n(v));
      dr("現金", o.cash); dr("普通預金", o.bank); dr("売掛金", o.ar); dr("棚卸資産", o.inv); dr("前払金", o.prepaid);
      const fixed = {};
      for (const a of assets) {
        const r = Filing.assetYear(a, y);
        if (r && !r.acquiredThisYear) fixed[a.cat || "工具器具備品"] = (fixed[a.cat || "工具器具備品"] || 0) + r.open;
      }
      for (const [k, v] of Object.entries(fixed)) dr(k, v);
      cr("未払金", o.ap); cr("借入金", o.loan); cr("前受金", o.advance); cr("預り金", o.deposit);
      const diff = L.reduce((t, l) => t + l.dr - l.cr, 0);
      if (!L.length) continue;
      if (diff) cr("元入金", diff);
      out.push({ id: uuid(), legacy_ids: ["opening:" + y], date: y + "-01-01", kind: "opening", source: "migrated", vendor: "", invoice_no: "", invoice_status: null, memo: "期首残高（開始仕訳）", rule_version: "2026.1", transaction: null, lines: L });
    }
    const fixedAssets = [];
    for (const a of assets) {
      const acquired = String(a.date).length === 7 ? a.date + "-01" : ymd(a.date);
      const acqYear = +acquired.slice(0, 4);
      const inOpening = firstOpen && acqYear < firstOpen;
      if (!inOpening) {
        const cost = n(a.cost), account = a.cat || "工具器具備品";
        out.push({ id: uuid(), legacy_ids: ["asset:" + a.id], date: acquired, kind: "normal", source: "migrated", vendor: "", invoice_no: "", invoice_status: null,
          memo: "固定資産取得：" + (a.name || ""), rule_version: "2026.1", transaction: null,
          lines: [{ account, dr: cost, cr: 0, tax_code: "P10", tax_amount: taxOf(cost, "P10") }, { account: a.paidFrom || "事業主借", dr: 0, cr: cost, tax_code: "-", tax_amount: 0 }] });
      }
      fixedAssets.push({ name: a.name || "", acquired, cost: n(a.cost), account: a.cat || "工具器具備品", asset_type: a.preset || "other", method: a.method || "sl", life: a.life, biz_ratio: a.ratio === "" || a.ratio == null ? 100 : +a.ratio, legacy_id: String(a.id) });
    }

    // 3) fiscal years: settings were global in the old app, so every year gets them
    const ctax = { exempt: ["exempt", "undecided"], simple: ["taxable", "simplified"], niwari: ["taxable", "niwari"], general: ["taxable", "general"] }[s.ctax] || ["taxable", "undecided"];
    const years = new Set([...out.map((e) => +e.date.slice(0, 4)), ...bsYears]);
    const fiscalYears = [...years].sort().map((year) => ({ year, filing: s.filing || "blue65", ctax_status: ctax[0], ctax_method: ctax[1], tax_inclusive: true }));

    return { documents: [...documents.values()], entries: out, fixed_assets: fixedAssets, fiscal_years: fiscalYears, warnings };
  }

  // net balance per year and account (debit positive)
  function balances(lines) {
    const tb = {};
    for (const { year, account, amt } of lines) { const k = year + "|" + account; tb[k] = (tb[k] || 0) + amt; }
    for (const k of Object.keys(tb)) if (!tb[k]) delete tb[k];
    return tb;
  }
  // Same balances as the old screens? Opening and asset-acquisition entries are new information, so they are left out.
  function verify(entries, payload, deps) {
    const { Books } = deps;
    const old = [];
    for (const e of entries) {
      if (!e || !e.date || Books.totalOf(e) <= 0) continue;
      for (const l of Books.linesOf(e)) { old.push({ year: e.date.slice(0, 4), account: l.dr, amt: l.amt }); old.push({ year: e.date.slice(0, 4), account: l.cr, amt: -l.amt }); }
    }
    const neu = [];
    let unbalanced = 0;
    for (const e of payload.entries) {
      const d = e.lines.reduce((t, l) => t + l.dr, 0), c = e.lines.reduce((t, l) => t + l.cr, 0);
      if (d !== c || e.lines.length < 2) unbalanced++;
      if (e.kind === "opening" || e.legacy_ids.some((x) => String(x).startsWith("asset:"))) continue;
      for (const l of e.lines) neu.push({ year: e.date.slice(0, 4), account: l.account, amt: l.dr - l.cr });
    }
    const a = balances(old), b = balances(neu);
    const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] || 0) !== (b[k] || 0)).map((k) => ({ key: k, old: a[k] || 0, new: b[k] || 0 }));
    return { ok: !diffs.length && !unbalanced, diffs, unbalanced, accounts: Object.keys(a).length };
  }

  const api = { plan, verify, rowLines, mergeLines, taxOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Migrate = api;
})(typeof window !== "undefined" ? window : globalThis);
