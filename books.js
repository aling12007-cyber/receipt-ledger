// Receipt Ledger — current bookkeeping core (one entry = one receipt row), shared by the page and the tests.
// Pure functions, no DOM. Exposes window.Books (and module.exports for tests).
// This is the pre-engine model: journal lines are derived on the fly from an entry. The Journal Engine
// (Accounting Core Completion Plan, P2) replaces it; until then the page and the Golden tests both use this file.
(function (root) {
  const totalOf = (e) => (+e.amt10 || 0) + (+e.amt8 || 0) + (+e.amt0 || 0);
  const ratioOf = (e) => Math.min(100, Math.max(0, e.bizRatio === "" || e.bizRatio == null ? 100 : +e.bizRatio)) / 100;
  const bizOf = (e) => (e.type === "income" ? totalOf(e) : Math.round(totalOf(e) * ratioOf(e)));

  // Journal lines of one entry: [{ dr, cr, amt, priv? }]
  function linesOf(e) {
    const total = totalOf(e);
    if (e.type === "income") return [{ dr: e.debit || "普通預金", cr: "売上高", amt: total }];
    const biz = bizOf(e), priv = total - biz, cr = e.credit || "事業主借";
    if (cr === "事業主借") return [{ dr: e.debit, cr, amt: biz }]; // private share paid privately: nothing to book
    const L = [{ dr: e.debit, cr, amt: biz }];
    if (priv > 0) L.push({ dr: "事業主貸", cr, amt: priv, priv: true });
    return L;
  }

  const inYear = (entries, year) => entries.filter((e) => String(e.date || "").startsWith(String(year)));

  // Dashboard figures from the old rows. depBusiness = this year's depreciation (business share), which the
  // 決算書 includes too, so both show the same income.
  function yearTotals(entries, year, depBusiness = 0) {
    const ys = inYear(entries, year);
    const sales = ys.filter((e) => e.type === "income").reduce((s, e) => s + totalOf(e), 0);
    const exps = ys.filter((e) => e.type !== "income");
    const expenses = exps.reduce((s, e) => s + bizOf(e), 0) + depBusiness;
    return { sales, expenses, income: sales - expenses, count: exps.length };
  }

  // インボイス経過措置: share of input tax creditable without a qualified invoice
  const transitionalRate = (date) => (date < "2026-10-01" ? 0.8 : date < "2029-10-01" ? 0.5 : 0);

  // 仕入税額 summary (tax-included bases, business share): qualified / not qualified / deductible part of not qualified
  function inputTaxBases(entries, year, qualOK) {
    let q10 = 0, q8 = 0, n10 = 0, n8 = 0, d10 = 0, d8 = 0;
    for (const e of inYear(entries, year)) {
      if (e.type === "income") continue;
      const r = ratioOf(e);
      if (qualOK(e)) { q10 += e.amt10 * r; q8 += e.amt8 * r; }
      else { n10 += e.amt10 * r; n8 += e.amt8 * r; d10 += e.amt10 * r * transitionalRate(e.date); d8 += e.amt8 * r * transitionalRate(e.date); }
    }
    return { q10, q8, n10, n8, d10, d8 };
  }

  const api = { totalOf, ratioOf, bizOf, linesOf, yearTotals, transitionalRate, inputTaxBases };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Books = api;
})(typeof window !== "undefined" ? window : globalThis);
