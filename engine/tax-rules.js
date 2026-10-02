// Receipt Ledger — tax rules by version. Nothing else in the code should hard-code a rate, limit or date:
// ask rulesFor(date) and use the version that was in force on that date (history keeps its own rules).
// Every rule names its official source. `checked` = the date the rule was compared with that source.
// Exposes window.TaxRules (and module.exports for tests).
(function (root) {
  const NTA_INVOICE = "https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice.htm";
  const NTA_2WARI = "https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_2tokurei.htm";
  const NTA_DEPRECIATION = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm";

  /**
   * @typedef {{ id: string, from: string, to: string|null,
   *   rates: { standard: number, reduced: number },
   *   invoiceTransitional: Array<{ from: string, to: string, rate: number }>,
   *   smallAmountInvoiceExemption: { below: number, until: string },
   *   publicTransportExemption: { below: number },
   *   individualSpecialRules: Array<{ key: string, years: number[], payableShareOfSalesTax: number }>,
   *   expenseBelow: number, lumpSum: { from: number, below: number, years: number },
   *   smallAsset: { below: number, belowFromTo: { below: number, from: string, to: string }, annualCap: number, blueOnly: boolean },
   *   blueDeduction: Record<string, number>,
   *   sources: Array<{ rule: string, url: string, checked: string|null }> }} RuleSet
   */

  /** @type {RuleSet[]} */
  const VERSIONS = [
    {
      id: "2026.1", from: "2026-01-01", to: null,
      rates: { standard: 10, reduced: 8 },
      // 適格請求書がない仕入れの経過措置（仕入税額相当額のうち控除できる割合）
      invoiceTransitional: [{ from: "2023-10-01", to: "2026-09-30", rate: 0.8 }, { from: "2026-10-01", to: "2029-09-30", rate: 0.5 }],
      smallAmountInvoiceExemption: { below: 10000, until: "2029-09-30" }, // 少額特例（基準期間の課税売上高1億円以下等の事業者）
      publicTransportExemption: { below: 30000 },                       // 公共交通機関特例（3万円未満）
      // 個人事業者: 2割特例 (令和5年10–12月分〜令和8年分), 3割特例 (令和9年・令和10年分)
      individualSpecialRules: [{ key: "niwari", years: [2023, 2024, 2025, 2026], payableShareOfSalesTax: 0.2 }, { key: "sanwari", years: [2027, 2028], payableShareOfSalesTax: 0.3 }],
      expenseBelow: 100000,                                              // 10万円未満は消耗品費等で全額経費
      lumpSum: { from: 100000, below: 200000, years: 3 },                // 一括償却資産
      smallAsset: { below: 300000, belowFromTo: { below: 400000, from: "2026-04-01", to: "2029-03-31" }, annualCap: 3000000, blueOnly: true }, // 少額減価償却資産の特例
      blueDeduction: { blue65: 650000, blue55: 550000, blue10: 100000, white: 0 },
      sources: [
        { rule: "invoiceTransitional, smallAmountInvoiceExemption, publicTransportExemption, rates", url: NTA_INVOICE, checked: null },
        { rule: "individualSpecialRules", url: NTA_2WARI, checked: "2026-10-02" },
        { rule: "expenseBelow, lumpSum, smallAsset", url: NTA_DEPRECIATION, checked: null },
      ],
    },
  ];

  /** @param {string} date YYYY-MM-DD @returns {RuleSet} */
  function rulesFor(date) {
    const d = String(date || "").slice(0, 10);
    const v = VERSIONS.filter((r) => r.from <= d && (!r.to || d <= r.to)).pop();
    return v || VERSIONS[0];
  }
  /** Share of input tax creditable without a qualified invoice on this date. @param {string} date */
  function transitionalRate(date) {
    const r = rulesFor(date), d = String(date).slice(0, 10);
    const p = r.invoiceTransitional.find((x) => x.from <= d && d <= x.to);
    return p ? p.rate : 0;
  }
  /** Tax included in a tax-inclusive amount (税込経理, rounded down). @param {number} gross @param {string} code @param {string} date */
  function taxIncluded(gross, code, date) {
    const { standard, reduced } = rulesFor(date).rates;
    const rate = code === "P10" || code === "S10" ? standard : code === "P8" || code === "S8" ? reduced : 0;
    return rate ? Math.floor(gross * rate / (100 + rate)) : 0;
  }
  /** What a purchase of this size usually is (固定資産の判定). @param {number} amount @param {string} date @param {boolean} blue */
  function assetClass(amount, date, blue) {
    const r = rulesFor(date), d = String(date).slice(0, 10);
    if (amount < r.expenseBelow) return "expense";
    const smallBelow = r.smallAsset.belowFromTo.from <= d && d <= r.smallAsset.belowFromTo.to ? r.smallAsset.belowFromTo.below : r.smallAsset.below;
    if (blue && amount < smallBelow) return "small";      // 少額減価償却資産（青色）
    if (amount < r.lumpSum.below) return "lump";           // 一括償却資産
    return "depreciate";                                   // 通常の減価償却
  }

  const api = { VERSIONS, rulesFor, transitionalRate, taxIncluded, assetClass };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaxRules = api;
})(typeof window !== "undefined" ? window : globalThis);
