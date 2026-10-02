// Receipt Ledger — Ledger Engine: everything the books show is computed here from posted journal entries.
// 仕訳帳 rows, 総勘定元帳 (running balance per account), 試算表, P&L figures, monthly figures, 地代家賃の内訳.
// Pure functions, no DOM, no network. Exposes window.Ledger (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Accounts = isNode ? require("./accounts.js") : root.Accounts;
  /* eslint-enable no-undef */

  /** @typedef {{ account: string, dr: number|string, cr: number|string, tax_code?: string, tax_amount?: number|string }} Line */
  /** @typedef {{ id?: string, date: string, kind?: string, status?: string, vendor?: string, memo?: string, lines: Line[], reverses?: string|null }} Entry */

  const num = (v) => Number(v) || 0;
  /** Only posted entries count (drafts and void entries never reach the books). @param {Entry[]} entries */
  const posted = (entries) => entries.filter((e) => !e.status || e.status === "posted");
  const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
  /** Debit-normal (asset, expense) or credit-normal (liability, equity, revenue). @param {string} account */
  const DEBIT_EQUITY = new Set(["事業主貸"]); // owner's drawings: equity, but its balance is on the debit side
  const normalSide = (account) => (!DEBIT_EQUITY.has(account) && ["liability", "equity", "revenue"].includes(Accounts.typeOf(account)) ? "cr" : "dr");
  const sortKey = (a) => { const m = Accounts.get(a); return m ? m.sort : 9000; };

  /**
   * 試算表. Opening = balance before `from` plus opening entries (期首残高); then debits, credits and the closing balance.
   * Balances are signed debit-positive; `balance` is shown on the account's normal side.
   * @param {Entry[]} entries @param {{ from?: string, to?: string }} [range]
   */
  function trialBalance(entries, range = {}) {
    const rows = new Map();
    const row = (a) => { if (!rows.has(a)) rows.set(a, { account: a, type: Accounts.typeOf(a) || "expense", opening: 0, dr: 0, cr: 0, closing: 0 }); return rows.get(a); };
    for (const e of posted(entries)) {
      if (range.to && e.date > range.to) continue;
      const before = range.from && e.date < range.from;
      for (const l of e.lines) {
        const r = row(l.account), d = num(l.dr), c = num(l.cr);
        if (before || e.kind === "opening") r.opening += d - c;
        else { r.dr += d; r.cr += c; }
      }
    }
    const list = [...rows.values()].map((r) => {
      r.closing = r.opening + r.dr - r.cr;
      return { ...r, normal: normalSide(r.account), balance: normalSide(r.account) === "dr" ? r.closing : -r.closing };
    }).filter((r) => r.opening || r.dr || r.cr).sort((a, b) => sortKey(a.account) - sortKey(b.account) || a.account.localeCompare(b.account));
    const totals = list.reduce((t, r) => ({ opening: t.opening + r.opening, dr: t.dr + r.dr, cr: t.cr + r.cr, closing: t.closing + r.closing }), { opening: 0, dr: 0, cr: 0, closing: 0 });
    return { rows: list, totals, balanced: totals.dr === totals.cr && totals.opening === 0 && totals.closing === 0 };
  }

  /**
   * 総勘定元帳 for one account: opening balance, then each line with the other side's accounts and a running balance.
   * @param {Entry[]} entries @param {string} account @param {{ from?: string, to?: string }} [range]
   */
  function generalLedger(entries, account, range = {}) {
    const side = normalSide(account), sign = side === "dr" ? 1 : -1;
    let opening = 0;
    const rows = [];
    const list = posted(entries).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "opening" ? -1 : 0) - (b.kind === "opening" ? -1 : 0));
    for (const e of list) {
      if (range.to && e.date > range.to) continue;
      const mine = e.lines.filter((l) => l.account === account);
      if (!mine.length) continue;
      if ((range.from && e.date < range.from) || e.kind === "opening") { for (const l of mine) opening += sign * (num(l.dr) - num(l.cr)); continue; }
      for (const l of mine) {
        const d = num(l.dr), c = num(l.cr);
        const others = [...new Set(e.lines.filter((x) => x.account !== account && (d ? num(x.cr) : num(x.dr))).map((x) => x.account))];
        rows.push({ date: e.date, entryId: e.id, kind: e.kind, memo: e.memo || "", vendor: e.vendor || "", counter: others.length > 1 ? "諸口" : others[0] || "", dr: d, cr: c, tax_code: l.tax_code || "-", balance: 0 });
      }
    }
    let bal = opening;
    for (const r of rows) { bal += sign * (r.dr - r.cr); r.balance = bal; }
    return { account, normal: side, opening, rows, closing: bal, dr: rows.reduce((s, r) => s + r.dr, 0), cr: rows.reduce((s, r) => s + r.cr, 0) };
  }

  /**
   * Profit and loss figures for a period: revenue, expenses per account, income (before 青色申告特別控除).
   * @param {Entry[]} entries @param {{ from?: string, to?: string }} [range]
   */
  function profitLoss(entries, range = {}) {
    const by = {}, counts = {};
    let sales = 0;
    for (const e of posted(entries)) {
      if (!inRange(e.date, range.from, range.to)) continue;
      for (const l of e.lines) {
        const t = Accounts.typeOf(l.account);
        if (t === "revenue") sales += num(l.cr) - num(l.dr);
        else if (t === "expense" || (!t && num(l.dr))) { by[l.account] = (by[l.account] || 0) + num(l.dr) - num(l.cr); counts[l.account] = (counts[l.account] || 0) + 1; }
      }
    }
    const expenses = Object.values(by).reduce((s, v) => s + v, 0);
    return { sales, by, counts, expenses, income: sales - expenses };
  }

  /** 月別: sales, expenses and 仕入 per month (青色申告決算書 2ページ). @param {Entry[]} entries @param {number} year */
  function monthly(entries, year) {
    const out = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, sales: 0, expenses: 0, purchases: 0 }));
    for (const e of posted(entries)) {
      if (!String(e.date).startsWith(String(year))) continue;
      const m = out[+e.date.slice(5, 7) - 1];
      for (const l of e.lines) {
        const t = Accounts.typeOf(l.account), v = num(l.dr) - num(l.cr);
        if (t === "revenue") m.sales -= v;
        else if (t === "expense") { m.expenses += v; if (l.account === "仕入高") m.purchases += v; }
      }
    }
    return out;
  }

  /** 地代家賃の内訳: per payee, the year's rent paid (incl. the private share) and the business share. @param {Entry[]} entries @param {number} year */
  function rentByPayee(entries, year) {
    const map = {};
    for (const e of posted(entries)) {
      if (!String(e.date).startsWith(String(year))) continue;
      const rent = e.lines.filter((l) => l.account === "地代家賃").reduce((s, l) => s + num(l.dr) - num(l.cr), 0);
      if (!rent) continue;
      const priv = e.lines.filter((l) => l.account === "事業主貸").reduce((s, l) => s + num(l.dr) - num(l.cr), 0);
      const k = (e.vendor || "").trim() || "（支払先未入力）";
      const o = map[k] || (map[k] = { payee: k, total: 0, business: 0, n: 0 });
      o.total += rent + priv; o.business += rent; o.n++;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }

  /** Has the year's depreciation already been posted as a closing entry? @param {Entry[]} entries @param {number} year */
  const depreciationPosted = (entries, year) => posted(entries).some((e) => e.kind === "closing" && String(e.date).startsWith(String(year)) && e.lines.some((l) => l.account === "減価償却費"));

  const api = { posted, normalSide, trialBalance, generalLedger, profitLoss, monthly, rentByPayee, depreciationPosted };
  if (isNode) module.exports = api;
  else root.Ledger = api;
})(typeof window !== "undefined" ? window : globalThis);
