// Receipt Ledger — Document Intelligence: what kind of document is this?
// receipt (領収書・レシート) · invoice (請求書) · bill (公共料金等の請求) · delivery_note (納品書)
// credit_card_statement (クレジットカード明細) · bank_statement (通帳・入出金明細) · contract (契約書) · other.
// Each type has its own parser; statements hold many transactions and go to CSV import instead of one entry.
// Exposes window.DocClassify (and module.exports for tests).
(function (root) {
  /** keyword → points per type (title words count most) @type {Record<string, Array<[RegExp, number]>>} */
  const RULES = {
    receipt: [[/領\s*収\s*[書証]/, 6], [/レシート/, 5], [/お預[りか]|お釣り?|おつり|釣銭/, 4], [/上記正に領収|但し.{0,10}として/, 5], [/合\s*計|お会計|お買上/, 2], [/小\s*計/, 1]],
    invoice: [[/請\s*求\s*書/, 7], [/ご請求金額|御請求金額|請求金額/, 4], [/お支払期限|支払期限|お振込期限/, 4], [/振込先|お振込先/, 3], [/下記の?通り(ご)?請求/, 4]],
    bill: [[/電気|ガス|水道/, 2], [/ご使用量|使用量|検針/, 4], [/ご使用期間|使用期間/, 3], [/電話料金|通信料|ご利用料金/, 2], [/口座振替/, 2]],
    delivery_note: [[/納\s*品\s*書/, 8], [/下記の?通り納品/, 5], [/納品日/, 3]],
    credit_card_statement: [[/ご利用(代金)?明細|カードご利用/, 6], [/お支払[い]?金額.{0,10}(日|月)/, 2], [/ご利用日/, 3], [/カード会社|会員番号/, 2], [/リボ|分割/, 2]],
    bank_statement: [[/通\s*帳|入出金明細|取引明細/, 6], [/残\s*高/, 3], [/お預入れ|お引出し|お引き出し|預入|払出/, 4], [/振込入金|振替/, 1]],
    contract: [[/契\s*約\s*書/, 8], [/(甲|乙)は/, 4], [/第\s*\d+\s*条/, 4], [/契約期間/, 3], [/記名押印/, 3]],
  };

  /**
   * @param {string} text OCR text (or PDF text)
   * @returns {{ type: string, confidence: number, scores: Record<string, number>, multiple: boolean }}
   */
  function classify(text) {
    const t = String(text || "");
    const head = t.split("\n").slice(0, 8).join("\n");
    /** @type {Record<string, number>} */
    const scores = {};
    for (const [type, rules] of Object.entries(RULES)) {
      let s = 0;
      for (const [re, pts] of rules) { if (re.test(t)) s += pts; if (re.test(head) && pts >= 5) s += 2; }
      scores[type] = s;
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [type, top] = ranked[0], second = ranked[1][1];
    if (top < 3) return { type: /合計|¥|円/.test(t) ? "receipt" : "other", confidence: 0.4, scores, multiple: false };
    const confidence = Math.round(Math.min(0.99, 0.55 + (top - second) / (top + 4)) * 100) / 100;
    return { type, confidence, scores, multiple: type === "credit_card_statement" || type === "bank_statement" };
  }

  const api = { classify, RULES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocClassify = api;
})(typeof window !== "undefined" ? window : globalThis);
