// Free, on-device receipt reading: Tesseract OCR with automatic language detection
// (Japanese / English / Chinese) + rules tuned for Japanese receipts.
// Used when the server has no ANTHROPIC_API_KEY. Exposes window.ReceiptOCR (and module.exports for tests).
(function (root) {
  const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

  // ---------- text normalisation ----------
  function normalize(text) {
    return String(text || "")
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[，､]/g, ",").replace(/[．]/g, ".").replace(/[／]/g, "/").replace(/[：]/g, ":")
      .replace(/[％]/g, "%").replace(/[￥]/g, "¥").replace(/[－―ー−](?=\d)/g, "-")
      .replace(/\r/g, "");
  }
  const toInt = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10);
  // amounts like "¥1,180" "1,180円" "1180" (allow OCR spaces inside the number)
  function amountsIn(line, decimals) {
    const out = [];
    if (decimals) {
      const rd = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/g;
      let d;
      while ((d = rd.exec(line))) { const v = parseFloat(d[1].replace(/,/g, "")); if (v > 0 && v < 1e8) out.push(v); }
      return out;
    }
    const re = /[¥\\]?\s*(\d{1,3}(?:[,.\s]\d{3})+|\d+)\s*(?:円|-)?/g;
    let m;
    while ((m = re.exec(line))) {
      const v = toInt(m[1]);
      if (!isNaN(v) && v > 0 && v < 100000000) out.push(v);
    }
    return out;
  }

  // ---------- language & currency ----------
  // ja: has kana. zh: many Han characters but (almost) no kana. en: mostly Latin letters.
  function scriptOf(text) {
    const t = String(text || "");
    const kana = (t.match(/[\u3040-\u30ff\uff66-\uff9f]/g) || []).length;
    const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    if (kana >= 3) return "ja";
    if (han >= 8 && han >= kana * 4) return "zh";
    if (latin >= 15 && latin > han * 2) return "en";
    return "ja";
  }
  function detectCurrency(t, lang) {
    if (/(NT\$|新台幣|新臺幣|TWD)/i.test(t)) return "TWD";
    if (/(HK\$|HKD|港幣|港币)/i.test(t)) return "HKD";
    if (/(人民币|人民幣|RMB|CNY)/i.test(t)) return "CNY";
    if (/(US\$|USD)/i.test(t)) return "USD";
    if (/(€|EUR\b)/.test(t)) return "EUR";
    if (/(£|GBP\b)/.test(t)) return "GBP";
    if (/(₩|KRW\b|원)/.test(t)) return "KRW";
    if (/(SGD|S\$)/.test(t)) return "SGD";
    if (/(円|JPY)/i.test(t)) return "JPY";
    if (lang === "ja") return "JPY";
    if (/\$/.test(t)) return "USD";
    if (lang === "zh" && /元/.test(t)) return /[们这买币单为价]/.test(t) ? "CNY" : "TWD";
    if (/[¥\\]/.test(t)) return lang === "zh" ? "CNY" : "JPY";
    return lang === "ja" ? "JPY" : "";
  }

  // ---------- field extraction ----------
  function findInvoiceNo(t) {
    // per line first, so the next line's digits never run into the number
    for (const l of t.split("\n")) {
      const m = l.replace(/[\s-]/g, "").match(/T(\d{13})(?!\d)/);
      if (m) return "T" + m[1];
    }
    const m = t.replace(/[\s-]/g, "").match(/登録番号:?T?(\d{13})/);
    return m ? "T" + m[1] : "";
  }

  function findDate(t, fallbackYear) {
    const pad = (n) => String(n).padStart(2, "0");
    const ok = (y, mo, d) => y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
    let m;
    // 令和8年9月30日 / R8.9.30 / R08/09/30
    if ((m = t.match(/(?:令和|R)\s*(\d{1,2})\s*[年./]\s*(\d{1,2})\s*[月./]\s*(\d{1,2})/))) {
      const y = 2018 + +m[1];
      if (ok(y, +m[2], +m[3])) return `${y}-${pad(m[2])}-${pad(m[3])}`;
    }
    // 2026年9月30日 / 2026/09/30 / 2026-09-30 / 2026.9.30
    if ((m = t.match(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/))) {
      if (ok(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    }
    // 26/09/30 (two-digit year)
    if ((m = t.match(/(?<!\d)(\d{2})\/(\d{1,2})\/(\d{1,2})(?!\d)/))) {
      const y = 2000 + +m[1];
      if (ok(y, +m[2], +m[3])) return `${y}-${pad(m[2])}-${pad(m[3])}`;
    }
    // 民國115年9月30日 / 115/09/30 (Taiwan receipts: ROC year + 1911)
    if ((m = t.match(/(?:民國|民国)?\s*(1\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/))) {
      const y = 1911 + +m[1];
      if (ok(y, +m[2], +m[3])) return `${y}-${pad(m[2])}-${pad(m[3])}`;
    }
    // 09/30/2026 (US order)
    if ((m = t.match(/(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})(?!\d)/))) {
      const a = +m[1], b = +m[2], y = +m[3];
      if (ok(y, a, b)) return `${y}-${pad(a)}-${pad(b)}`;
      if (ok(y, b, a)) return `${y}-${pad(b)}-${pad(a)}`;
    }
    // Sep 30, 2026 / 30 Sep 2026
    const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    if ((m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/i))) {
      const mo = MON[m[1].toLowerCase()];
      if (ok(+m[3], mo, +m[2])) return `${m[3]}-${pad(mo)}-${pad(m[2])}`;
    }
    if ((m = t.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2})/i))) {
      const mo = MON[m[2].toLowerCase()];
      if (ok(+m[3], mo, +m[1])) return `${m[3]}-${pad(mo)}-${pad(m[1])}`;
    }
    // 9月30日 (no year)
    if ((m = t.match(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
      if (ok(fallbackYear, +m[1], +m[2])) return `${fallbackYear}-${pad(m[1])}-${pad(m[2])}`;
    }
    return "";
  }

  const TOTAL_WORDS = /(合\s*計|総\s*計|總\s*計|总\s*计|合\s*计|總\s*額|总\s*额|お?買\s*上|ご?請求|領収金額|お支払|支払金額|税込計|應\s*付|应\s*付|實\s*付|实\s*付|AMOUNT\s*DUE|BALANCE\s*DUE|GRAND\s*TOTAL|TOTAL)/i;
  const EXCLUDE_WORDS = /(お預|預り|お釣|釣銭|おつり|ポイント|点数|内税|消費税|税額|対象|小計|小计|找零|找續|稅額|税额|SUB\s*TOTAL|CHANGE|TENDERED|\bTAX\b|\bVAT\b|\bGST\b)/i;
  function findTotal(lines, decimals) {
    let best = 0;
    for (const l of lines) {
      if (TOTAL_WORDS.test(l) && !EXCLUDE_WORDS.test(l)) {
        const a = amountsIn(l.replace(TOTAL_WORDS, " "), decimals);
        if (a.length) best = Math.max(best, a[a.length - 1]);
      }
    }
    if (best) return best;
    // fallback: largest ¥ / 円 amount that isn't change or tendered
    for (const l of lines) {
      if (EXCLUDE_WORDS.test(l) || !(decimals ? /[$€£₩元\d]/ : /[¥\\円]/).test(l)) continue;
      for (const v of amountsIn(l, decimals)) best = Math.max(best, v);
    }
    return best;
  }

  // "(10%対象 ¥1,100)" "8%対象 540" "軽減税率対象 540"
  function findRateBase(lines, rate) {
    const re = rate === 8 ? /(8\s*%|軽減)/ : /10\s*%/;
    for (const l of lines) {
      if (!re.test(l) || !/対象/.test(l)) continue;
      const a = amountsIn(l.replace(/\d+\s*%/g, " "));
      if (a.length) return a[0];
    }
    return 0;
  }
  // "内消費税 (8%) ¥40" style lines, used when 対象 base is missing
  function findRateTax(lines, rate) {
    const re = rate === 8 ? /(8\s*%|軽減)/ : /10\s*%/;
    for (const l of lines) {
      if (!re.test(l) || !/(税|消費)/.test(l) || /対象/.test(l)) continue;
      const a = amountsIn(l.replace(/\d+\s*%/g, " "));
      if (a.length) return a[a.length - 1];
    }
    return 0;
  }

  function findVendor(lines) {
    for (const l of lines.slice(0, 8)) {
      const s = l.replace(/[|_~=*#<>「」【】()（）]/g, "").replace(/(?<=[^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "").replace(/\s+/g, " ").trim();
      if (s.length < 2 || s.length > 30) continue;
      if (/(領収|レシート|receipt|電話|TEL|〒|\d{2,4}-\d{2,4}-\d{3,4}|登録番号|^T\d)/i.test(s)) continue;
      const letters = (s.match(/[A-Za-z぀-ヿ一-鿿]/g) || []).length;
      if (letters / s.length >= 0.6) return s;
    }
    return "";
  }

  const ACCOUNT_RULES = [
    [/(タクシー|交通|JR|鉄道|駅|乗車|SUICA|PASMO|ICOCA|バス|新幹線|航空|高速|駐車|パーキング|ガソリン|ENEOS|出光|コスモ石油)/i, "旅費交通費"],
    [/(郵便|切手|レターパック|ゆうパック|携帯|docomo|ドコモ|au|softbank|ソフトバンク|楽天モバイル|通信)/i, "通信費"],
    [/(ヤマト|佐川|宅急便|宅配|運輸)/, "荷造運賃"],
    [/(書店|書房|ブック|BOOK|紀伊國屋|丸善|ジュンク|蔦屋|TSUTAYA|新聞)/i, "新聞図書費"],
    [/(収入印紙|印紙)/, "租税公課"],
    [/(振込手数料|手数料)/, "支払手数料"],
    [/(カフェ|CAFE|CAFÉ|COFFEE|コーヒー|珈琲|喫茶|咖啡|星巴克|スターバックス|STARBUCKS|ドトール|タリーズ|コメダ|ルノアール)/i, "会議費"],
    [/(居酒屋|焼肉|寿司|鮨|料亭|ダイニング|レストラン|酒場|BAR)/i, "接待交際費"],
    [/(電気|ガス|水道)/, "水道光熱費"],
    [/(セミナー|研修|講座|受講)/, "研修費"],
    [/(ヨドバシ|ビックカメラ|ヤマダ|ダイソー|セリア|ロフト|LOFT|ハンズ|無印|文具|事務用品|アスクル|ASKUL|AMAZON|アマゾン|ホームセンター|コーナン|カインズ)/i, "消耗品費"],
  ];
  // The store name decides first; item lines only for non-food rules (a coffee bought at a
  // convenience store is not a meeting, and "Suica" on a café receipt is just how it was paid).
  const TEXT_ONLY_SKIP = new Set(["会議費", "接待交際費", "旅費交通費"]);
  function guessAccount(vendor, t) {
    for (const [re, acc] of ACCOUNT_RULES) if (vendor && re.test(vendor)) return acc;
    for (const [re, acc] of ACCOUNT_RULES) if (!TEXT_ONLY_SKIP.has(acc) && re.test(t)) return acc;
    if (/(運賃|乗車|タクシー)/.test(t)) return "旅費交通費";
    return "消耗品費";
  }
  function guessPayment(t) {
    if (/(クレジット|CREDIT|VISA|MASTER|JCB|AMEX|カード|信用卡|刷卡)/i.test(t)) return "card";
    if (/(電子マネー|SUICA|PASMO|ICOCA|PAYPAY|楽天ペイ|QUICPAY|ID払|WAON|NANACO|EDY|悠遊卡|一卡通|LINE\s*PAY|街口|支付宝|支付寶|微信|ALIPAY|WECHAT|APPLE\s*PAY|GOOGLE\s*PAY)/i.test(t)) return "emoney";
    if (/(現金|现金|お預り|お預かり|預り|CASH)/i.test(t)) return "cash";
    return "unknown";
  }

  // Returns the same shape as the server's AI reader.
  function parseReceiptText(raw, opts) {
    const year = (opts && opts.year) || new Date().getFullYear();
    const text = normalize(raw);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const lang = (opts && opts.lang) || scriptOf(text);
    const currency = detectCurrency(text, lang) || "JPY";
    if (currency !== "JPY") {
      // Overseas purchase: amounts are not yen and are outside Japanese consumption tax.
      const date = findDate(text, year), vendor = findVendor(lines);
      return {
        date: date || null, vendor, invoice_no: null, items: "",
        amount_10: 0, amount_8: 0, amount_other: 0, total: 0,
        foreign_total: findTotal(lines, true), currency, language: lang,
        payment: guessPayment(text), account: guessAccount(vendor, text),
        confidence: "low", notes: "",
      };
    }
    const total = findTotal(lines);
    let a8 = findRateBase(lines, 8), a10 = findRateBase(lines, 10);
    if (!a8) { const tax8 = findRateTax(lines, 8); if (tax8) a8 = Math.round(tax8 * 108 / 8); }
    if (!a10 && a8 && total > a8) a10 = total - a8;
    if (!a10 && !a8) a10 = total;
    let other = 0;
    if (total && a10 + a8 !== total) {
      if (a10 + a8 < total) other = total - a10 - a8;
      else if (a8 && a8 <= total) a10 = total - a8; // OCR misread on one base
      else { a10 = total; a8 = 0; }
    }
    const date = findDate(text, year);
    const vendor = findVendor(lines);
    const found = [total > 0, !!date, !!findInvoiceNo(text)].filter(Boolean).length;
    return {
      date: date || null,
      vendor,
      invoice_no: findInvoiceNo(text) || null,
      items: "",
      amount_10: a10, amount_8: a8, amount_other: other, total,
      payment: guessPayment(text),
      account: guessAccount(vendor, text),
      currency: "JPY", language: lang,
      confidence: found >= 2 ? "medium" : "low",
      notes: "",
    };
  }

  // ---------- OCR ----------
  const workers = {};
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (root.Tesseract) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the OCR engine"));
      document.head.appendChild(s);
    });
  }
  let progressCb = null;
  function getWorker(langs) {
    if (!workers[langs]) {
      workers[langs] = (async () => {
        await loadScript(TESSERACT_SRC);
        const w = await root.Tesseract.createWorker(langs, 1, { logger: (m) => progressCb && progressCb(m) });
        await w.setParameters({ preserve_interword_spaces: "1" });
        return w;
      })().catch((e) => { delete workers[langs]; throw e; });
    }
    return workers[langs];
  }
  // language → Tesseract models used for the second, focused pass
  const PASS2 = { zh: "chi_tra+chi_sim+eng", en: "eng" };
  // Grayscale + contrast stretch helps Tesseract on thermal receipts.
  async function prepare(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
      let lo = 255, hi = 0; const g = new Uint8ClampedArray(p.length / 4);
      for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; g[j] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
      const k = 255 / Math.max(1, hi - lo);
      for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = (g[j] - lo) * k; p[i] = p[i + 1] = p[i + 2] = v; }
      ctx.putImageData(d, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  const cleanText = (t) => (t || "").replace(/(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])/g, ""); // drop OCR spaces between CJK chars
  async function readReceipt(blob, opts) {
    progressCb = opts && opts.onProgress;
    const canvas = await prepare(blob);
    // Pass 1: Japanese + English covers almost every receipt issued in Japan.
    let text = cleanText((await (await getWorker("jpn+eng")).recognize(canvas)).data.text);
    const lang = scriptOf(text);
    // Pass 2: re-read with the right models when the receipt is Chinese or English.
    if (PASS2[lang]) {
      if (opts && opts.onLanguage) opts.onLanguage(lang);
      try { text = cleanText((await (await getWorker(PASS2[lang])).recognize(canvas)).data.text); } catch (e) { /* keep pass-1 text */ }
    }
    const r = parseReceiptText(text, { ...(opts || {}), lang });
    r.raw_text = text;
    return r;
  }

  const api = { parseReceiptText, readReceipt, normalize, scriptOf, detectCurrency };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
