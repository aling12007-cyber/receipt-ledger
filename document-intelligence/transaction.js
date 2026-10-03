// Receipt Ledger — Document Intelligence: Receipt → Transaction → Journal.
//   suggestAccount(): the AI / rules / the user's history recommend an account (with confidence and reason) — a
//     recommendation only; the user confirms it. Equipment of ¥100,000 or more is a fixed-asset candidate, never
//     silently booked as supplies.
//   fromReview(): the Transaction made from a reviewed document (date, merchant, amount, tax, rate, category, payment,
//     account suggestion, confidence, source document, status).
//   toJournal(): its journal lines, which must balance (debits = credits) before anything is posted.
// Exposes window.DocTransaction (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Mer = isNode ? require("./merchant.js") : root.DocMerchant;
  // resolved when used: in the page, engine/tax-rules.js loads after this file
  const taxRules = () => (isNode ? require("../engine/tax-rules.js") : root.TaxRules);
  /* eslint-enable no-undef */

  const EQUIPMENT = /(PC|パソコン|ノート|MacBook|iMac|Mac\s?mini|iPad|iPhone|Surface|ThinkPad|モニター|ディスプレイ|プリンター|複合機|カメラ|レンズ|サーバー|NAS|ルーター|タブレット|スマートフォン|机|デスク|チェア|椅子|エアコン|冷蔵庫|車両|自動車|バイク)/i;
  const REASON = {
    history: { ja: "この店舗で過去に{n}回この科目を確認済み", zh: "這家店過去 {n} 次都確認為此科目", en: "You chose this account {n} times for this shop" },
    ai: { ja: "AIが品目と店舗から判断", zh: "AI 依品項和店家判斷", en: "AI judged from the items and shop" },
    rules: { ja: "店名・品目のキーワードから判断", zh: "依店名、品項的關鍵字判斷", en: "From keywords in the shop name and items" },
    default: { ja: "判断材料が少ないため既定の科目", zh: "判斷依據不足，使用預設科目", en: "Not enough clues — default account" },
  };

  /**
   * @param {{ merchant?: string, text?: string, amount?: number, date?: string, blue?: boolean, knowledge?: any[],
   *   ai?: { account?: string, confidence?: string } | null, rules?: { account: string } | null }} o
   * @returns {{ account: string, confidence: number, source: string, reason: Record<string,string>, alternatives: Array<{ account: string, source: string }>,
   *   fixedAssetCandidate: null | { cost: number, assetClass: string } }}
   */
  function suggestAccount(o) {
    const cands = [];
    const hist = o.knowledge && o.merchant ? Mer.suggest(o.merchant, o.knowledge) : null;
    if (hist) cands.push({ account: hist.account, confidence: hist.confidence, source: "history", n: hist.uses });
    if (o.ai && o.ai.account) cands.push({ account: o.ai.account, confidence: o.ai.confidence === "high" ? 0.85 : o.ai.confidence === "medium" ? 0.7 : 0.5, source: "ai" });
    // keyword rules: specific evidence (taxi, rent, stamps, utilities…) is fairly reliable; supplies vs meetings needs a person
    const RULE_CONF = { 旅費交通費: 0.8, 水道光熱費: 0.8, 通信費: 0.8, 租税公課: 0.8, 地代家賃: 0.8, 荷造運賃: 0.8, 新聞図書費: 0.75, 支払手数料: 0.75, 研修費: 0.75, 広告宣伝費: 0.7, 会議費: 0.6, 接待交際費: 0.6 };
    if (o.rules && o.rules.account) cands.push({ account: o.rules.account, confidence: RULE_CONF[o.rules.account] ?? 0.5, source: "rules" });
    // agreement between independent sources raises confidence
    for (const c of cands) { const agree = cands.filter((x) => x !== c && x.account === c.account).length; if (agree) c.confidence = Math.min(0.97, 1 - (1 - c.confidence) * Math.pow(0.5, agree)); }
    const best = cands.sort((a, b) => b.confidence - a.confidence)[0] || { account: "雑費", confidence: 0.3, source: "default", n: 0 };
    const reason = Object.fromEntries(Object.entries(REASON[best.source]).map(([l, s]) => [l, s.replace("{n}", String(best.n || 0))]));
    // ¥100,000+ equipment: a fixed asset (depreciated), not supplies — the user confirms which treatment applies
    let fixedAssetCandidate = null;
    const amount = Number(o.amount) || 0;
    if (amount >= 100000 && (EQUIPMENT.test(String(o.text || "")) || ["消耗品費", "工具器具備品", "車両運搬具"].includes(best.account))) {
      fixedAssetCandidate = { cost: amount, assetClass: taxRules().assetClass(amount, o.date || new Date().toISOString().slice(0, 10), o.blue !== false) };
    }
    return { account: best.account, confidence: Math.round(best.confidence * 100) / 100, source: best.source, reason,
      alternatives: cands.filter((c) => c.account !== best.account).map((c) => ({ account: c.account, source: c.source })), fixedAssetCandidate };
  }

  const dominant = (bd) => { const r = (bd || []).filter((b) => b.rate).sort((a, b) => (b.taxableAmount || 0) - (a.taxableAmount || 0)); return r.length ? r[0].rate : 0; };

  /**
   * The Transaction for a reviewed receipt (one per account line when a receipt is split).
   * @param {{ entry: any, extraction?: any, confidence?: any, validation?: any, suggestion?: any, sourceDocument?: string|null, status?: string, totalOf: (e: any) => number }} o
   */
  function fromReview(o) {
    const e = o.entry, ex = o.extraction || null;
    const amount = o.totalOf(e);
    const tax = Math.floor(((Number(e.amt10) || 0) * 10) / 110) + Math.floor(((Number(e.amt8) || 0) * 8) / 108);
    const m = Mer.normalize(e.vendor || "");
    const rates = [Number(e.amt10) ? 10 : null, Number(e.amt8) ? 8 : null, Number(e.amt0) ? 0 : null].filter((x) => x != null);
    return {
      date: e.date, merchant: { raw: m.raw, normalized: m.normalized }, amount, tax,
      taxRate: rates.length === 1 ? rates[0] : rates.length ? rates : dominant(ex && ex.taxBreakdown),
      taxCategory: rates.length > 1 ? "mixed" : rates[0] === 8 ? "reduced" : rates[0] === 0 ? "nontaxable_or_outside" : "standard",
      paymentMethod: (ex && ex.paymentMethod && ex.paymentMethod.value) || null, creditAccount: e.credit,
      account: e.debit, accountSuggestion: o.suggestion || null, businessRatio: e.bizRatio ?? 100,
      invoiceRegistrationNumber: e.invoiceNo || null, invoiceStatus: ex ? ex.invoiceStatus.value : e.invoiceNo ? "registered" : "not_found",
      confidence: o.confidence ? o.confidence.overall : null, validation: o.validation ? o.validation.status : null,
      sourceDocumentId: o.sourceDocument || null, status: o.status || "user_confirmed",
    };
  }

  /**
   * Journal lines for a transaction's entry; refuses anything that does not balance.
   * @param {any} entry @param {(row: any) => Array<{ account: string, dr: number, cr: number }>} rowLines
   */
  function toJournal(entry, rowLines) {
    const lines = rowLines(entry);
    const dr = lines.reduce((s, l) => s + (Number(l.dr) || 0), 0), cr = lines.reduce((s, l) => s + (Number(l.cr) || 0), 0);
    const balanced = lines.length >= 2 && dr === cr && dr > 0;
    return { lines, debit: dr, credit: cr, balanced };
  }

  const api = { suggestAccount, fromReview, toJournal, EQUIPMENT };
  if (isNode) module.exports = api;
  else root.DocTransaction = api;
})(typeof window !== "undefined" ? window : globalThis);
