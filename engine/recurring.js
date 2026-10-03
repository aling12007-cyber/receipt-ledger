// Receipt Ledger — recurring entries (rent, phone, internet, subscriptions): one rule → one record per month.
// Records get a fixed id (rec-<rule>-<YYYY-MM>), so running this again never creates a month twice, and a month the
// user deleted is remembered (skip list) and not created again.
// Exposes window.Recurring (and module.exports for tests).
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");
  /** @param {string} ym @param {number} k */
  const addMonths = (ym, k) => { const [y, m] = ym.split("-").map(Number), d = new Date(Date.UTC(y, m - 1 + k, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
  const lastDay = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

  /**
   * @typedef {{ id: string, name: string, vendor?: string, debit: string, credit?: string, amount: number, rate?: "10"|"8"|"0",
   *   bizRatio?: number, day?: number, start: string, end?: string, auto?: boolean, invoiceNo?: string }} Rule
   * start / end: YYYY-MM · day: day of month (1–31, capped at the month's last day) · auto: record without asking
   */

  /** Record for one month of a rule. @param {Rule} r @param {string} ym */
  function recordFor(r, ym) {
    const day = Math.min(Math.max(1, +r.day || 1), lastDay(ym));
    const a = Math.max(0, Math.round(+r.amount || 0)), rate = r.rate || "10";
    return { id: `rec-${r.id}-${ym}`, type: "expense", date: `${ym}-${pad(day)}`, vendor: r.vendor || r.name || "", items: r.name || "", invoiceNo: r.invoiceNo || "",
      amt10: rate === "10" ? a : 0, amt8: rate === "8" ? a : 0, amt0: rate === "0" ? a : 0, debit: r.debit, credit: r.credit || "事業主借",
      bizRatio: r.bizRatio ?? 100, memo: "定期取引：" + (r.name || ""), recurringId: r.id };
  }

  /**
   * Months that are due and not recorded yet.
   * @param {Rule[]} rules @param {Set<string>|string[]} existingIds @param {Set<string>|string[]} skip @param {string} today YYYY-MM-DD
   * @returns {{ auto: any[], confirm: any[] }}
   */
  function due(rules, existingIds, skip, today) {
    const have = new Set(existingIds), skipped = new Set(skip), out = { auto: [], confirm: [] };
    const thisMonth = today.slice(0, 7);
    for (const r of rules || []) {
      if (!r || !r.start || !r.debit || !(+r.amount > 0)) continue;
      for (let ym = r.start, n = 0; ym <= thisMonth && n < 60; ym = addMonths(ym, 1), n++) {
        if (r.end && ym > r.end) break;
        const rec = recordFor(r, ym);
        if (rec.date > today || have.has(rec.id) || skipped.has(rec.id)) continue;
        (r.auto === false ? out.confirm : out.auto).push(rec);
      }
    }
    return out;
  }

  const api = { recordFor, due, addMonths };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Recurring = api;
})(typeof window !== "undefined" ? window : globalThis);
