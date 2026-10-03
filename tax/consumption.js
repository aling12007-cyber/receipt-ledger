// Receipt Ledger — consumption tax return for a sole proprietor: 本則課税 vs 2割特例 (3割特例) vs 簡易課税.
// Figures follow the return form (消費税及び地方消費税の申告書 第一表): 課税標準額 (千円未満切捨て), 消費税額 (国税 7.8% / 6.24%),
// 控除対象仕入税額, 差引税額 (百円未満切捨て), 地方消費税 = 差引税額 × 22/78 (百円未満切捨て). 割戻し計算 (税込経理).
// Exposes window.ConsumptionTax (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const NTA_2WARI = "https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_2tokurei.htm";
  const NTA_KANI = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm";
  /** 簡易課税のみなし仕入率 by 事業区分. */
  const DEEMED = { 1: 0.9, 2: 0.8, 3: 0.7, 4: 0.6, 5: 0.5, 6: 0.4 };
  const KIND_EXAMPLES = { 1: "卸売業", 2: "小売業・飲食料品の譲渡を行う農林漁業", 3: "製造業・建設業・農林漁業", 4: "飲食店業など", 5: "サービス業（デザイン・コンサル・IT等）・金融保険業・運輸通信業", 6: "不動産業" };
  const SOURCES = [{ rule: "2割特例 / 3割特例", url: NTA_2WARI, checked: "2026-10-02" }, { rule: "みなし仕入率", url: NTA_KANI, checked: "2026-10-03" }];
  const floor = (v, unit) => (v >= 0 ? Math.floor(v / unit) * unit : -Math.floor(-v / unit) * unit);

  /**
   * Aggregates from the records of one year (business share; tax-included amounts).
   * @param {any[]} entries records (type, date, amt10, amt8, amt0, bizRatio, invoiceNo …)
   * @param {number} year
   * @param {{ qualOK: (e: any) => boolean, ratioOf: (e: any) => number, transitionalRate: (date: string) => number, assets?: any[] }} h
   */
  function aggregate(entries, year, h) {
    const a = { sales10: 0, sales8: 0, salesOther: 0, q10: 0, q8: 0, n10: 0, n8: 0, credit10: 0, credit8: 0, count: 0, nonQualifiedCount: 0 };
    for (const e of entries) {
      if (!String(e.date || "").startsWith(String(year))) continue;
      if (e.type === "income") { a.sales10 += +e.amt10 || 0; a.sales8 += +e.amt8 || 0; a.salesOther += +e.amt0 || 0; continue; }
      const r = h.ratioOf(e), x10 = (+e.amt10 || 0) * r, x8 = (+e.amt8 || 0) * r;
      if (!x10 && !x8) continue;
      a.count++;
      if (h.qualOK(e)) { a.q10 += x10; a.q8 += x8; a.credit10 += x10; a.credit8 += x8; }
      else { a.n10 += x10; a.n8 += x8; a.nonQualifiedCount++; const t = h.transitionalRate(e.date); a.credit10 += x10 * t; a.credit8 += x8 * t; }
    }
    // fixed assets bought this year (business share) are purchases too under 本則課税
    for (const as of h.assets || []) {
      if (!String(as.date || "").startsWith(String(year))) continue;
      const c = (+as.cost || 0) * ((as.ratio ?? 100) / 100);
      a.q10 += c; a.credit10 += c;
    }
    for (const k of Object.keys(a)) a[k] = Math.round(a[k]);
    return a;
  }

  /**
   * @param {ReturnType<typeof aggregate>} a
   * @param {{ year: number, kind?: number, niwariEligible?: boolean, simpleElected?: boolean }} o
   *   kind: 簡易課税の事業区分 (1–6) · niwariEligible: インボイス登録で課税事業者になった（登録しなければ免税）· simpleElected: 簡易課税制度選択届出書を提出済み
   */
  function compute(a, o) {
    const base10 = floor((a.sales10 * 100) / 110, 1000), base8 = floor((a.sales8 * 100) / 108, 1000);
    const base = base10 + base8;                                                          // ① 課税標準額
    const outTax = Math.floor(base10 * 0.078) + Math.floor(base8 * 0.0624);               // ② 消費税額
    const local = (n) => floor((Math.max(0, n) * 22) / 78, 100);
    const result = (key, credit, note) => {
      const nat = floor(outTax - credit, 100);                                            // ⑨ 差引税額 (or ⑧ 控除不足還付税額 when negative)
      const loc = nat > 0 ? local(nat) : -floor((-nat * 22) / 78, 100);
      return { key, base, outTax, credit: Math.floor(credit), national: nat, local: loc, total: nat + loc, note };
    };
    // 本則: 仕入税額 = 税込仕入 × 7.8/110 (6.24/108); 適格請求書のない仕入は経過措置の割合だけ
    const generalCredit = Math.floor((a.credit10 * 7.8) / 110) + Math.floor((a.credit8 * 6.24) / 108);
    const methods = [result("general", generalCredit, "")];
    const special = o.year <= 2026 ? { key: "niwari", share: 0.2 } : o.year <= 2028 ? { key: "sanwari", share: 0.3 } : null;
    if (special && o.niwariEligible) methods.push(result(special.key, outTax * (1 - special.share), ""));
    if (o.kind && DEEMED[o.kind]) methods.push({ ...result("simple", outTax * DEEMED[o.kind], ""), available: !!o.simpleElected });
    for (const m of methods) if (m.available === undefined) m.available = true;
    const usable = methods.filter((m) => m.available);
    const best = usable.reduce((b, m) => (m.total < b.total ? m : b), usable[0]);
    return { year: o.year, sales: { s10: a.sales10, s8: a.sales8, other: a.salesOther }, base, base10, base8, outTax, methods, best: best.key,
      saving: Math.max(0, methods[0].total - best.total), deemedRate: o.kind ? DEEMED[o.kind] : null };
  }

  const api = { DEEMED, KIND_EXAMPLES, SOURCES, aggregate, compute };
  if (isNode) module.exports = api;
  else root.ConsumptionTax = api;
})(typeof window !== "undefined" ? window : globalThis);
