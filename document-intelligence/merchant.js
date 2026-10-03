// Receipt Ledger — Document Intelligence: merchant normalization and the user's merchant knowledge.
//   "ローソン 新宿店" / "LAWSON" / "株式会社ローソン" → "ローソン" (the raw name is always kept as well)
//   knowledge: what the user confirmed before for that merchant (merchant_knowledge) → account suggestion.
// Learning only suggests: it never overrides tax rules and never changes entries the user already confirmed.
// Exposes window.DocMerchant (and module.exports for tests).
(function (root) {
  /** Well-known brands: any of the patterns → one name. @type {Array<[RegExp, string]>} */
  const ALIASES = [
    [/ローソン|LAWSON/i, "ローソン"], [/ファミリーマート|ファミマ|FAMILY\s*MART/i, "ファミリーマート"], [/セブン[-ー‐\s]?イレブン|SEVEN[-\s]?ELEVEN|7-?ELEVEN/i, "セブン-イレブン"],
    [/ミニストップ|MINISTOP/i, "ミニストップ"], [/スターバックス|STARBUCKS/i, "スターバックス"], [/ドトール|DOUTOR/i, "ドトール"], [/タリーズ|TULLY/i, "タリーズ"],
    [/AMAZON|アマゾン/i, "Amazon"], [/APPLE|アップル/i, "Apple"], [/ヨドバシ|YODOBASHI/i, "ヨドバシカメラ"], [/ビックカメラ|BIC\s*CAMERA/i, "ビックカメラ"],
    [/東京電力|TEPCO/i, "東京電力"], [/東京ガス|TOKYO\s*GAS/i, "東京ガス"], [/NTT\s*ドコモ|DOCOMO|ドコモ/i, "NTTドコモ"], [/NTT東日本|NTT西日本|^NTT$/i, "NTT"],
    [/ソフトバンク|SOFTBANK/i, "ソフトバンク"], [/\bKDDI\b|\bAU\b/i, "KDDI"], [/JR東日本|東日本旅客鉄道/i, "JR東日本"], [/JR東海|東海旅客鉄道/i, "JR東海"],
    [/日本郵便|郵便局|JAPAN\s*POST/i, "日本郵便"], [/ヤマト運輸|YAMATO/i, "ヤマト運輸"], [/佐川急便|SAGAWA/i, "佐川急便"],
    [/マクドナルド|MCDONALD/i, "マクドナルド"], [/ユニクロ|UNIQLO/i, "ユニクロ"], [/無印良品|MUJI/i, "無印良品"], [/ダイソー|DAISO/i, "ダイソー"], [/コメダ/i, "コメダ珈琲"],
  ];
  const COMPANY = /(株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|[（(]\s*[株有同]\s*[)）]|㈱|㈲)/g;
  const BRANCH = /\s*([^\s]{1,12}(店|支店|営業所|出張所|センター|SC)|本店)$/;
  const toHalf = (s) => String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");

  /**
   * @param {string} raw merchant name as printed
   * @returns {{ raw: string, normalized: string, branch: string, alias: boolean }}
   */
  function normalize(raw) {
    const r = String(raw || "").trim();
    let s = toHalf(r).replace(COMPANY, " ").replace(/\s+/g, " ").trim();
    for (const [re, name] of ALIASES) if (re.test(s)) return { raw: r, normalized: name, branch: (s.match(BRANCH) || ["", ""])[1] || "", alias: true };
    let branch = "";
    const m = s.match(BRANCH);
    if (m && s.length - m[0].length >= 2) { branch = m[1]; s = s.slice(0, s.length - m[0].length).trim(); }
    return { raw: r, normalized: s.replace(/\s+/g, ""), branch, alias: false };
  }

  /**
   * Account suggestion from the user's confirmed history for this merchant.
   * @param {string} merchant raw or normalized name
   * @param {Array<{ merchant: string, account: string, uses: number }>} knowledge rows of merchant_knowledge (or built from entries)
   * @returns {{ account: string, confidence: number, uses: number, alternatives: Array<{ account: string, uses: number }> } | null}
   */
  function suggest(merchant, knowledge) {
    const key = normalize(merchant).normalized;
    if (!key) return null;
    const rows = knowledge.filter((k) => k.merchant === key).sort((a, b) => b.uses - a.uses);
    if (!rows.length) return null;
    const total = rows.reduce((s, k) => s + k.uses, 0), top = rows[0];
    // more confirmations and a clear majority → more confidence (never 1: it is a habit, not a rule)
    const confidence = Math.round(Math.min(0.95, (top.uses / total) * (1 - Math.pow(0.6, top.uses))) * 100) / 100;
    return { account: top.account, confidence, uses: top.uses, alternatives: rows.slice(1).map((k) => ({ account: k.account, uses: k.uses })) };
  }

  /** Knowledge rows built from existing records (when merchant_knowledge is not set up yet). @param {Array<{ vendor?: string, debit?: string, type?: string }>} entries */
  function fromEntries(entries) {
    const map = new Map();
    for (const e of entries) {
      if (e.type === "income" || !e.vendor || !e.debit) continue;
      const k = normalize(e.vendor).normalized + "\t" + e.debit;
      map.set(k, (map.get(k) || 0) + 1);
    }
    return [...map].map(([k, uses]) => { const [merchant, account] = k.split("\t"); return { merchant, account, uses }; });
  }

  const api = { normalize, suggest, fromEntries, ALIASES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocMerchant = api;
})(typeof window !== "undefined" ? window : globalThis);
