// Receipt Ledger — Document Intelligence: amount and tax validation of an extraction.
//   subtotal (+ tax when 税抜) − discount = total · items ≈ subtotal · tax per rate matches the rate
//   rate taxes ≈ printed tax total · per-rate amounts + 非課税 ≈ total · date plausible · 登録番号 status
// Rounding: Japanese receipts round tax per rate (切捨て / 四捨五入 / 切上げ), so 1 yen per rate is allowed.
// status "error" blocks automatic posting (the user must look at it); "warning" is shown for review.
// Exposes window.DocValidate (and module.exports for tests).
(function (root) {
  const CONFIG = { yenPerRate: 1, itemTolerance: 0.02, maxFutureDays: 1 };

  const MSG = {
    TOTAL_MISSING: { ja: "合計金額が読み取れません", zh: "讀不到合計金額", en: "Total could not be read" },
    DATE_MISSING: { ja: "日付が読み取れません", zh: "讀不到日期", en: "Date could not be read" },
    DATE_FUTURE: { ja: "日付が未来になっています", zh: "日期在未來", en: "Date is in the future" },
    DATE_OTHER_YEAR: { ja: "日付が対象年度外です", zh: "日期不在本年度", en: "Date is outside the tax year" },
    SUBTOTAL_TOTAL: { ja: "小計・消費税・値引と合計が一致しません", zh: "小計、稅額、折扣和合計對不起來", en: "Subtotal, tax and discount do not add up to the total" },
    ITEMS_SUM: { ja: "品目の合計が小計（合計）と一致しません", zh: "品項加總和小計（合計）不一致", en: "Items do not add up to the subtotal (total)" },
    RATE_TAX: { ja: "税率と税額が合いません", zh: "稅率和稅額對不起來", en: "Tax amount does not match the rate" },
    TAX_TOTAL: { ja: "税率ごとの税額と消費税合計が一致しません", zh: "各稅率稅額加總和消費稅合計不一致", en: "Tax per rate does not add up to the tax total" },
    BREAKDOWN_TOTAL: { ja: "10%・8%・非課税の金額と合計が一致しません", zh: "10%、8%、非課稅金額加總和合計不一致", en: "10% / 8% / non-taxable amounts do not add up to the total" },
    INVOICE_UNCERTAIN: { ja: "登録番号の読み取りが不確実です。レシートで確認してください", zh: "登錄番號讀取不確定，請對照收據確認", en: "Registration number reading is uncertain — check the receipt" },
    INVOICE_CHECKDIGIT: { ja: "登録番号のチェックデジットが合いません（法人の場合）", zh: "登錄番號檢查碼不符（法人時）", en: "Registration number check digit fails (corporation)" },
    FORM_SPLIT: { ja: "10%・8%・不課税の入力額の合計が合計金額と違います", zh: "10%、8%、不課稅的輸入金額加總和合計不同", en: "The amounts entered per rate differ from the total" },
    STATEMENT: { ja: "明細書（複数の取引）です。CSV取込を使ってください", zh: "這是明細（多筆交易），請用 CSV 匯入", en: "This is a statement with many transactions — use CSV import" },
  };
  /** @param {string} code @param {string} lang */
  const message = (code, lang) => (MSG[code] ? MSG[code][lang] || MSG[code].ja : code);

  const v = (f) => (f && f.value != null && f.value !== "" ? f.value : null);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  /**
   * @param {any} e Extraction
   * @param {{ year?: number, today?: string, form?: { amt10?: number, amt8?: number, amt0?: number } }} [o]
   * @param {Partial<typeof CONFIG>} [cfg]
   * @returns {{ status: "ok"|"warning"|"error", checks: Array<{ code: string, level: "ok"|"warning"|"error", fields: string[], detail?: any }>, blockAutoPost: boolean, inclusive: boolean|null }}
   */
  function validate(e, o = {}, cfg = {}) {
    const C = { ...CONFIG, ...cfg };
    const checks = [];
    const add = (code, level, fields, detail) => checks.push({ code, level, fields, detail });
    const total = v(e.total), sub = v(e.subtotal), disc = v(e.discount) || 0, taxTotal = v(e.taxTotal);
    const bd = (e.taxBreakdown || []).filter((b) => b.source !== "derived");
    const docType = v(e.documentType);

    if (docType === "credit_card_statement" || docType === "bank_statement") add("STATEMENT", "error", ["documentType"]);
    if (total == null) add("TOTAL_MISSING", "error", ["total"]);
    const date = v(e.issueDate);
    if (!date) add("DATE_MISSING", "error", ["issueDate"]);
    else {
      const today = o.today || new Date().toISOString().slice(0, 10);
      const future = (Date.parse(date) - Date.parse(today)) / 864e5;
      if (future > C.maxFutureDays) add("DATE_FUTURE", "error", ["issueDate"], { date, today });
      if (o.year && Number(date.slice(0, 4)) !== o.year) add("DATE_OTHER_YEAR", "warning", ["issueDate"], { date, year: o.year });
    }

    // 税込 or 税抜: printed, or inferred from which equation holds
    const rateTaxes = bd.filter((b) => b.rate && b.taxAmount != null);
    const sumRateTax = rateTaxes.reduce((s, b) => s + b.taxAmount, 0);
    const tax = taxTotal ?? (rateTaxes.length ? sumRateTax : null);
    const tol = C.yenPerRate * Math.max(1, rateTaxes.length);
    let inclusive = e.taxInclusive ?? null;
    if (total != null && sub != null) {
      const incOk = near(sub - disc, total, tol), excOk = tax != null && near(sub + tax - disc, total, tol);
      if (inclusive == null) inclusive = excOk && !incOk ? false : incOk ? true : null;
      const ok = inclusive === false ? excOk : inclusive === true ? incOk || excOk : incOk || excOk;
      add("SUBTOTAL_TOTAL", ok ? "ok" : "error", ["subtotal", "taxTotal", "discount", "total"], { subtotal: sub, tax, discount: disc, total, inclusive });
    }

    // tax per rate must match the rate
    for (const b of rateTaxes) {
      if (b.taxableAmount == null) continue;
      const inc = (b.inclusive ?? inclusive) !== false;
      const exact = inc ? (b.taxableAmount * b.rate) / (100 + b.rate) : (b.taxableAmount * b.rate) / 100;
      const ok = Math.abs(b.taxAmount - exact) <= 1;   // floor / round / ceil all within 1 yen
      add("RATE_TAX", ok ? "ok" : "error", ["taxBreakdown", "taxTotal"], { rate: b.rate, base: b.taxableAmount, tax: b.taxAmount, expected: Math.round(exact * 100) / 100, inclusive: inc });
    }
    // (a tax total that is only the sum of the rate taxes cannot be checked against them)
    if (taxTotal != null && rateTaxes.length && !(e.taxTotal && e.taxTotal.source === "sum-of-rates")) add("TAX_TOTAL", near(sumRateTax, taxTotal, tol) ? "ok" : "error", ["taxBreakdown", "taxTotal"], { sum: sumRateTax, taxTotal });

    // 10% + 8% + 非課税 … = total (tax-included amounts)
    const withBase = bd.filter((b) => b.taxableAmount != null);
    if (total != null && withBase.length) {
      const incl = withBase.reduce((s, b) => s + (b.rate && (b.inclusive ?? inclusive) === false ? b.taxableAmount + (b.taxAmount ?? Math.floor((b.taxableAmount * b.rate) / 100)) : b.taxableAmount), 0);
      // a breakdown that covers only part of the receipt (e.g. only the 8% line printed) is not an error
      const covers = withBase.some((b) => b.rate === 10) || withBase.length >= 2;
      if (covers) add("BREAKDOWN_TOTAL", near(incl, total, tol + disc) ? "ok" : "warning", ["taxBreakdown", "total"], { sum: incl, total });
    }

    // items ≈ subtotal (or total)
    const items = (e.items || []).filter((i) => Number.isFinite(i.amount));
    if (items.length >= 2 && (sub ?? total) != null) {
      const s = items.reduce((t, i) => t + i.amount, 0), ref = sub ?? total;
      const okItems = Math.abs(s - ref) <= Math.max(items.length, ref * C.itemTolerance) || (disc && near(s - disc, ref, items.length));
      add("ITEMS_SUM", okItems ? "ok" : "warning", ["items", sub != null ? "subtotal" : "total"], { items: s, reference: ref });
    }

    // 登録番号
    const st = v(e.invoiceStatus);
    if (st === "uncertain") add("INVOICE_UNCERTAIN", "warning", ["invoiceRegistrationNumber"], e.invoiceCheck);
    if (e.invoiceCheck && e.invoiceCheck.checkDigit === "ng") add("INVOICE_CHECKDIGIT", "warning", ["invoiceRegistrationNumber"]);

    // the form's 10% / 8% / 0% split against the total
    if (o.form && total != null) {
      const f = (Number(o.form.amt10) || 0) + (Number(o.form.amt8) || 0) + (Number(o.form.amt0) || 0);
      if (f && f !== total) add("FORM_SPLIT", "warning", ["total"], { form: f, total });
    }

    const status = checks.some((c) => c.level === "error") ? "error" : checks.some((c) => c.level === "warning") ? "warning" : "ok";
    return { status, checks, blockAutoPost: status === "error", inclusive };
  }

  const api = { CONFIG, validate, message, MSG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocValidate = api;
})(typeof window !== "undefined" ? window : globalThis);
