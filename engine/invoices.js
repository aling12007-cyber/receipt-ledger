// Receipt Ledger — 請求書 (適格請求書 / qualified invoice) for a sole proprietor.
// Amounts per line are 税抜 (tax-exclusive), as usual between businesses; consumption tax is computed once per rate per
// invoice (端数処理は税率ごとに1回, 切捨て), which is what the invoice system requires.
// 適格請求書の記載事項: ① 発行者の氏名・名称と登録番号 ② 取引年月日 ③ 取引内容（軽減税率対象はその旨）
// ④ 税率ごとの合計額と適用税率 ⑤ 税率ごとの消費税額 ⑥ 受け取る人の氏名・名称.
// Issuing books the sale (売掛金 / 売上高); the payment is booked separately (普通預金 / 売掛金) — 入金消込.
// Exposes window.Invoices (and module.exports for tests).
(function (root) {
  const isRegNo = (s) => /^T\d{13}$/.test(String(s || ""));

  /**
   * @typedef {{ name: string, qty: number, unit: number, rate: 10|8|0 }} Line   unit: 税抜単価
   * @typedef {{ id: string, no: string, issueDate: string, due?: string, client: string, honorific?: string, subject?: string,
   *   lines: Line[], notes?: string, status?: "draft"|"issued"|"paid", paidDate?: string, paidAmount?: number, fee?: number,
   *   entryId?: string, payKey?: string }} Invoice
   * @typedef {{ name: string, regNo?: string, address?: string, tel?: string, email?: string, bank?: string }} Issuer
   */

  /** @param {Invoice} inv */
  function compute(inv) {
    const by = { 10: 0, 8: 0, 0: 0 };
    for (const l of inv.lines || []) {
      const r = +l.rate === 8 ? 8 : +l.rate === 0 ? 0 : 10;
      by[r] += Math.round((+l.qty || 0) * (+l.unit || 0));
    }
    const tax10 = Math.floor((by[10] * 10) / 100), tax8 = Math.floor((by[8] * 8) / 100);
    const subtotal = by[10] + by[8] + by[0];
    return { net10: by[10], net8: by[8], net0: by[0], tax10, tax8, subtotal, tax: tax10 + tax8,
      gross10: by[10] + tax10, gross8: by[8] + tax8, total: subtotal + tax10 + tax8 };
  }

  /** Missing items. Codes: issuer, regNo, date, client, lines, lineName. @param {Invoice} inv @param {Issuer} issuer */
  function validate(inv, issuer) {
    const e = [];
    if (!issuer || !String(issuer.name || "").trim()) e.push("issuer");
    if (!isRegNo(issuer && issuer.regNo)) e.push("regNo");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(inv.issueDate || ""))) e.push("date");
    if (!String(inv.client || "").trim()) e.push("client");
    const lines = (inv.lines || []).filter((l) => String(l.name || "").trim() || +l.unit);
    if (!lines.length || compute(inv).subtotal <= 0) e.push("lines");
    if (lines.some((l) => !String(l.name || "").trim())) e.push("lineName");
    return { ok: !e.length, errors: e, qualified: !e.includes("issuer") && !e.includes("regNo") };
  }

  /** Next number for the year: INV-2026-001 … @param {Invoice[]} list @param {string} date */
  function nextNumber(list, date) {
    const y = String(date || "").slice(0, 4), re = new RegExp(`^INV-${y}-(\\d+)$`);
    const n = Math.max(0, ...(list || []).map((v) => { const m = String(v.no || "").match(re); return m ? +m[1] : 0; }));
    return `INV-${y}-${String(n + 1).padStart(3, "0")}`;
  }

  /** Due date: end of the next month (月末締め翌月末払い). @param {string} date */
  function defaultDue(date) {
    const [y, m] = date.split("-").map(Number), d = new Date(Date.UTC(y, m + 1, 0));
    return d.toISOString().slice(0, 10);
  }

  /** The sale record (売掛金 / 売上高), tax-included per rate. @param {Invoice} inv */
  function toEntry(inv) {
    const c = compute(inv);
    return { id: "inv-" + inv.id, type: "income", date: inv.issueDate, vendor: inv.client, invoiceNo: "", items: `請求書 ${inv.no}${inv.subject ? " " + inv.subject : ""}`.slice(0, 80),
      amt10: c.gross10, amt8: c.gross8, amt0: c.net0, debit: "売掛金", credit: "売上高", bizRatio: 100, memo: "請求書発行" };
  }

  /** The payment (入金消込) as a quick entry for Journal.fromQuickEntry: 普通預金 (+ 支払手数料) / 売掛金. */
  function paymentEntry(inv, o) {
    const c = compute(inv), received = Math.round(+o.amount || 0), fee = Math.max(0, c.total - received);
    return { type: "collect", date: o.date, vendor: inv.client, amount: c.total, fee, from: "売掛金", to: o.to || "普通預金", description: `入金 ${inv.no}` };
  }

  /** @param {Invoice} inv @param {string} today */
  function status(inv, today) {
    if (inv.status === "paid") return "paid";
    if (inv.status !== "issued") return "draft";
    return inv.due && inv.due < today ? "overdue" : "issued";
  }

  const api = { compute, validate, nextNumber, defaultDue, toEntry, paymentEntry, status, isRegNo };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Invoices = api;
})(typeof window !== "undefined" ? window : globalThis);
