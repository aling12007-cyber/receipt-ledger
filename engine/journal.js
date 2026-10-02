// Receipt Ledger — Journal Engine: builds, checks, reverses and corrects journal entries (仕訳).
// Pure functions, no DOM, no network. The database enforces the same rules again (002_accounting_core.sql).
// Exposes window.Journal (and module.exports for tests).
//
//   fromQuickEntry(input)  ＋取引を登録: a few plain fields → a journal entry candidate + what was suggested and why
//   validate(entry)        balance, accounts, tax codes, tax amounts → errors (block posting) and warnings
//   reverse(entry)         逆仕訳 that cancels a posted entry
//   correct(old, fixed)    訂正 = reversal of the old entry + the corrected entry (the old one stays on the books)
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Accounts = isNode ? require("./accounts.js") : root.Accounts;
  const TaxRules = isNode ? require("./tax-rules.js") : root.TaxRules;
  /* eslint-enable no-undef */

  /** @typedef {{ account: string, dr: number, cr: number, tax_code: string, tax_amount: number, memo?: string }} Line */
  /** @typedef {{ id?: string, date: string, kind: string, vendor: string, invoice_no: string, memo: string, lines: Line[], reverses?: string|null, invoice_status?: string|null, rule_version?: string }} Entry */
  /**
   * @typedef {{ type?: "expense"|"sale"|"transfer"|"collect"|"settle", date: string, vendor?: string, amount: number, description?: string,
   *   payment?: string, account?: string, taxCode?: string, taxRate?: number, bizRatio?: number, invoiceNo?: string,
   *   from?: string, to?: string, fee?: number, blue?: boolean }} QuickEntry
   */
  /** @typedef {{ field: string, value: any, confidence: number, reason: string }} Suggestion */

  const TAX_CODES = ["-", "P10", "P8", "PN", "PX", "S10", "S8", "SN", "SE", "SX"];
  const isInvoice = (s) => /^T\d{13}$/.test(String(s || ""));

  /** @param {string} account @param {number} dr @param {number} cr @param {string} code @param {string} date @returns {Line} */
  function line(account, dr, cr, code, date) {
    return { account, dr, cr, tax_code: code, tax_amount: TaxRules.taxIncluded(dr || cr, code, date) };
  }

  // ---------- suggestions ----------
  const EQUIPMENT = /(パソコン|PC|ノートパソコン|MacBook|iMac|iPad|タブレット|モニター|ディスプレイ|プリンター|複合機|カメラ|レンズ|サーバー|NAS|机|デスク|椅子|チェア|エアコン|冷蔵庫|スマートフォン|スマホ|iPhone)/i;
  const SOFTWARE = /(ソフトウェア|ライセンス|Adobe|Microsoft 365|Office|サブスク|月額|年額)/i;
  const RESIDENTIAL = /(自宅|住宅|マンション|アパート|居住)/;

  /**
   * Account and tax suggestions for an expense, each with a confidence and the reason (shown to the user).
   * @param {QuickEntry} q
   * @param {{ guess?: (vendor: string, text: string) => { account: string }, learned?: (vendor: string) => (string|null) }} [hints]
   * @returns {{ account: Suggestion, taxCode: Suggestion, notes: string[] }}
   */
  function suggestExpense(q, hints = {}) {
    const text = [q.vendor, q.description].filter(Boolean).join(" ");
    const notes = [];
    /** @type {Suggestion} */
    let account;
    const learned = hints.learned && hints.learned(q.vendor || "");
    if (q.account) account = { field: "account", value: q.account, confidence: 1, reason: "入力" };
    else if (learned) account = { field: "account", value: learned, confidence: 0.9, reason: "過去の修正（同じ取引先）" };
    else if (EQUIPMENT.test(text)) account = { field: "account", value: "消耗品費", confidence: 0.7, reason: "備品・機器" };
    else if (SOFTWARE.test(text)) account = { field: "account", value: "通信費", confidence: 0.6, reason: "ソフトウェア利用料" };
    else if (hints.guess) { const g = hints.guess(q.vendor || "", text); account = { field: "account", value: g.account, confidence: g.account === "消耗品費" ? 0.4 : 0.7, reason: "取引先・内容のルール" }; }
    else account = { field: "account", value: "消耗品費", confidence: 0.3, reason: "既定" };

    // 10万円以上の備品は固定資産の候補
    const cls = TaxRules.assetClass(q.amount, q.date, q.blue !== false);
    if (account.value === "消耗品費" && cls !== "expense" && (EQUIPMENT.test(text) || q.amount >= TaxRules.rulesFor(q.date).expenseBelow)) {
      account = { field: "account", value: "工具器具備品", confidence: 0.6, reason: "10万円以上の備品" };
      notes.push(cls === "small" ? "fixedAssetSmall" : cls === "lump" ? "fixedAssetLump" : "fixedAsset");
    }

    const acc = Accounts.get(account.value);
    /** @type {Suggestion} */
    let taxCode;
    if (q.taxCode) taxCode = { field: "taxCode", value: q.taxCode, confidence: 1, reason: "入力" };
    else if (q.taxRate === 8) taxCode = { field: "taxCode", value: "P8", confidence: 1, reason: "軽減税率 8%" };
    else if (q.taxRate === 0) taxCode = { field: "taxCode", value: "PX", confidence: 0.8, reason: "税なし" };
    else if (account.value === "地代家賃" && (RESIDENTIAL.test(text) || (q.bizRatio != null && q.bizRatio < 100)))
      taxCode = { field: "taxCode", value: "PN", confidence: 0.7, reason: "住宅の家賃は非課税" };
    else taxCode = { field: "taxCode", value: acc ? acc.defaultTax : "P10", confidence: acc && acc.defaultTax !== "P10" ? 0.8 : 0.7, reason: "科目の既定の税区分" };

    if (Accounts.MIXED_USE.has(account.value) && (q.bizRatio == null || q.bizRatio === 100)) notes.push("allocation");
    if (!isInvoice(q.invoiceNo) && (taxCode.value === "P10" || taxCode.value === "P8")) notes.push("noInvoice");
    return { account, taxCode, notes };
  }

  // ---------- quick entry → journal entry ----------
  /**
   * @param {QuickEntry} q
   * @param {Parameters<typeof suggestExpense>[1]} [hints]
   * @returns {{ entry: Entry, suggestions: Suggestion[], notes: string[] }}
   */
  function fromQuickEntry(q, hints) {
    const date = String(q.date || "").slice(0, 10), amount = Math.round(+q.amount || 0), type = q.type || "expense";
    const base = { date, kind: "normal", vendor: q.vendor || "", invoice_no: q.invoiceNo || "", memo: q.description || "", lines: /** @type {Line[]} */ ([]) };
    /** @type {Suggestion[]} */
    const suggestions = [];
    let notes = [];
    if (type === "expense") {
      const s = suggestExpense(q, hints);
      suggestions.push(s.account, s.taxCode);
      notes = s.notes;
      const credit = Accounts.PAYMENT_ACCOUNT[q.payment || "cash"] || q.payment || "現金";
      const ratio = Math.min(100, Math.max(0, q.bizRatio == null ? 100 : +q.bizRatio)) / 100;
      const biz = Math.round(amount * ratio);
      base.lines.push(line(s.account.value, biz, 0, s.taxCode.value, date));
      if (credit === "事業主借") base.lines.push(line(credit, 0, biz, "-", date));          // private money: the private share is not booked
      else {
        if (amount - biz > 0) base.lines.push(line("事業主貸", amount - biz, 0, "-", date)); // 家事按分: private share
        base.lines.push(line(credit, 0, amount, "-", date));
      }
      base.invoice_status = isInvoice(q.invoiceNo) ? "確認済" : amount < TaxRules.rulesFor(date).publicTransportExemption.below && s.account.value === "旅費交通費" ? "対象外" : "要確認";
    } else if (type === "sale") {
      const debit = Accounts.PAYMENT_ACCOUNT[q.payment || "bank"] || q.payment || "普通預金";
      const code = q.taxCode || (q.taxRate === 8 ? "S8" : q.taxRate === 0 ? "SX" : "S10");
      base.lines.push(line(debit, amount, 0, "-", date), line(q.account || "売上高", 0, amount, code, date));
      base.invoice_status = null;
    } else if (type === "collect" || type === "settle") {
      // 入金: 売掛金 → 普通預金 (振込手数料を差し引かれた場合は支払手数料)  / 支払: 未払金・買掛金 → 普通預金
      const fee = Math.round(+q.fee || 0), bank = q.to || "普通預金";
      if (type === "collect") {
        base.lines.push(line(bank, amount - fee, 0, "-", date));
        if (fee) base.lines.push(line("支払手数料", fee, 0, "P10", date));
        base.lines.push(line(q.from || "売掛金", 0, amount, "-", date));
      } else {
        base.lines.push(line(q.to || "未払金", amount, 0, "-", date), line(q.from || "普通預金", 0, amount, "-", date));
      }
      base.kind = base.lines.length > 2 ? "compound" : "transfer";
      base.invoice_status = null;
    } else if (type === "transfer") {
      base.lines.push(line(q.to, amount, 0, "-", date), line(q.from, 0, amount, "-", date));
      base.kind = "transfer";
      base.invoice_status = null;
    } else throw new Error("unknown entry type " + type);
    if (base.lines.length > 2 && base.kind === "normal") base.kind = "compound";
    base.rule_version = TaxRules.rulesFor(date).id;
    return { entry: base, suggestions, notes };
  }

  // ---------- checks ----------
  /**
   * @param {Entry} e
   * @param {{ accountExists?: (name: string) => boolean, yearLocked?: (year: number) => boolean }} [ctx]
   * @returns {{ ok: boolean, errors: Array<{ code: string, detail?: any }>, warnings: Array<{ code: string, detail?: any }> }}
   */
  function validate(e, ctx = {}) {
    const errors = [], warnings = [];
    const exists = ctx.accountExists || ((n) => !!Accounts.get(n));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) errors.push({ code: "DATE" });
    if (!e.lines || e.lines.length < 2) errors.push({ code: "TOO_FEW_LINES" });
    let dr = 0, cr = 0;
    for (const l of e.lines || []) {
      if (!exists(l.account)) errors.push({ code: "UNKNOWN_ACCOUNT", detail: l.account });
      if (!TAX_CODES.includes(l.tax_code)) errors.push({ code: "TAX_CODE", detail: l.tax_code });
      if (!(l.dr > 0) === !(l.cr > 0) || l.dr < 0 || l.cr < 0 || !Number.isInteger(l.dr) || !Number.isInteger(l.cr)) errors.push({ code: "LINE_SIDE", detail: l.account });
      dr += l.dr || 0; cr += l.cr || 0;
      const want = TaxRules.taxIncluded(l.dr || l.cr, l.tax_code, e.date);
      if (l.tax_amount !== want) warnings.push({ code: "TAX_AMOUNT", detail: { account: l.account, entered: l.tax_amount, computed: want } });
      const t = Accounts.typeOf(l.account);
      if ((t === "liability" || t === "equity" || (t === "asset" && !String(l.tax_code).startsWith("P"))) && l.tax_code !== "-") warnings.push({ code: "TAX_CODE_ON_BALANCE", detail: l.account });
    }
    if (dr !== cr) errors.push({ code: "UNBALANCED", detail: { dr, cr } });
    if (ctx.yearLocked && e.date && ctx.yearLocked(+e.date.slice(0, 4))) errors.push({ code: "YEAR_LOCKED" });
    return { ok: errors.length === 0, errors, warnings };
  }

  // ---------- reversal and correction ----------
  /** @param {Entry & { id: string }} e @param {string} [date] @returns {Entry} */
  function reverse(e, date) {
    return {
      date: date || e.date, kind: "reversal", reverses: e.id, vendor: e.vendor, invoice_no: e.invoice_no, invoice_status: e.invoice_status || null,
      memo: "取消：" + (e.memo || ""), rule_version: e.rule_version,
      lines: e.lines.map((l) => ({ ...l, dr: l.cr, cr: l.dr })),
    };
  }
  /** @param {Entry & { id: string }} old @param {Entry} fixed @param {string} [date] @returns {Entry[]} */
  function correct(old, fixed, date) {
    return [reverse(old, date), { ...fixed, memo: fixed.memo || old.memo }];
  }

  /** Net balance per account, debit positive. @param {Entry[]} entries */
  function balances(entries) {
    /** @type {Record<string, number>} */
    const tb = {};
    for (const e of entries) for (const l of e.lines) tb[l.account] = (tb[l.account] || 0) + l.dr - l.cr;
    return tb;
  }

  const api = { fromQuickEntry, suggestExpense, validate, reverse, correct, balances, TAX_CODES };
  if (isNode) module.exports = api;
  else root.Journal = api;
})(typeof window !== "undefined" ? window : globalThis);
