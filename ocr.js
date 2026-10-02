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
      .replace(/\r/g, "")
      // common OCR confusions next to digits: o/O→0, l/I/|→1, S→5 (only between/after digits)
      .replace(/(?<=\d[,.]?\s?\d{0,2})[oO](?=\d|\b)/g, "0")
      .replace(/(?<=\d)[oO]/g, "0").replace(/[oO](?=\d{2})/g, "0")
      .replace(/(?<=\d)[lI|](?=\d)/g, "1");
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
    const re = /([¥\\vVwW4])?\s*(\d{1,3}(?:(?:[,.]\s?|\s)\d{3})+|\d+)\s*(?:円|-)?/g;
    let m;
    while ((m = re.exec(line))) {
      let digits = m[2];
      // "42.310" / "v2.310": the ¥ sign was read as 4 or v → also offer the number without it
      if (/^4\d[,.]\s?\d{3}/.test(digits)) { const alt = toInt(digits.slice(1)); if (alt > 0) out.push(alt); }
      const v = toInt(digits);
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
    // OCR misread the first digit of the year ("9026/09/02") → trust the last two digits
    if ((m = t.match(/(?<!\d)\d(\d)(\d{2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})(?!\d)/))) {
      const y = 2000 + +m[2];
      if (m[1] === "0" && Math.abs(y - fallbackYear) <= 1 && ok(y, +m[3], +m[4])) return `${y}-${pad(m[3])}-${pad(m[4])}`;
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
    if (!decimals) return findYenTotal(lines);
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

  // Yen total by evidence: the real total is usually printed several times (合計, 対象額, お預り,
  // card line) and equals 小計 + 税 (外税) — robust when OCR garbles the 合計 label itself.
  function findYenTotal(lines) {
    const info = new Map();
    const add = (v, key) => { if (v < 10 || v >= 10000000) return; const o = info.get(v) || { n: 0, total: 0, excl: 0 }; o.n++; o[key]++; info.set(v, o); };
    for (const l of lines) {
      const isTotal = TOTAL_WORDS.test(l) && !EXCLUDE_WORDS.test(l);
      const isExcl = /(お預|預り|お釣|釣銭|おつり|ポイント|点数|找零)/.test(l);
      for (const v of amountsIn(l)) add(v, isTotal ? "total" : isExcl ? "excl" : "n0");
    }
    if (!info.size) return 0;
    const vals = [...info.keys()];
    const set = new Set(vals);
    const near = (a, b) => Math.abs(a - b) <= 1;
    let best = 0, bestScore = -Infinity;
    for (const v of vals) {
      const o = info.get(v);
      let score = o.n + 3 * o.total - 2 * (o.excl === o.n ? 1 : 0);
      // v = subtotal + exclusive tax (10% or 8%)
      for (const a of vals) { const b = v - a; if (b > 0 && set.has(b) && (near(b, Math.round(a * 0.1)) || near(b, Math.round(a * 0.08)) || near(b, Math.floor(a * 0.1)) || near(b, Math.floor(a * 0.08)))) { score += 4; break; } }
      // inclusive tax printed: (内消費税 ¥210) where 210 ≈ v*10/110
      for (const t of vals) if (t < v && (near(t, Math.floor(v * 10 / 110)) || near(t, Math.floor(v * 8 / 108)))) { score += 2; break; }
      if (score > bestScore || (score === bestScore && v > best)) { best = v; bestScore = score; }
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

  const ADDRESS = /(〒|東京都|北海道|大阪府|京都府|.{1,3}県|.{1,4}[市区町村].{0,8}\d|TEL|電話|☎)/i;
  function vendorOk(l) {
    const s = l.replace(/[|_~=*#<>「」【】()（）\[\]]/g, "").replace(/(?<=[^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "").replace(/\s+/g, " ").trim();
    if (s.length < 2 || s.length > 30) return "";
    if (/(領収|レシート|receipt|電話|TEL|〒|\d{2,4}-\d{2,4}-\d{3,4}|登録番号|^T\d|^\d)/i.test(s)) return "";
    const letters = (s.match(/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    return letters / s.replace(/\s/g, "").length >= 0.7 ? s : "";
  }
  function findVendor(lines) {
    const head = lines.slice(0, 12);
    const ai = head.findIndex((l) => ADDRESS.test(l));
    for (let i = ai - 1; ai > 0 && i >= Math.max(0, ai - 2); i--) { const v = vendorOk(head[i]); if (v) return v; }
    const ri = head.findIndex((l) => /(領\s*収\s*[書証]|レシート|RECEIPT)/i.test(l));
    for (let i = ri + 1; ri >= 0 && i <= Math.min(head.length - 1, ri + 2); i++) { const v = vendorOk(head[i]); if (v) return v; }
    for (const l of lines.slice(0, 8)) { const v = vendorOk(l); if (v) return v; }
    return "";
  }


  const ACCOUNT_RULES = [
    [/(タクシー|交通|JR|鉄道|駅|乗車|SUICA|PASMO|ICOCA|バス|新幹線|航空|高速|駐車|パーキング|ガソリン|ENEOS|出光|コスモ石油)/i, "旅費交通費"],
    [/(郵便|切手|レターパック|ゆうパック|携帯|docomo|ドコモ|KDDI|au by|softbank|ソフトバンク|楽天モバイル|通信料)/i, "通信費"],
    [/(ヤマト|佐川|宅急便|宅配|運輸)/, "荷造運賃"],
    [/(書店|書房|ブック|BOOK|紀伊國屋|丸善|ジュンク|蔦屋|TSUTAYA|新聞)/i, "新聞図書費"],
    [/(収入印紙|印紙)/, "租税公課"],
    [/(振込手数料|手数料)/, "支払手数料"],
    [/(カフェ|CAFE|CAFÉ|COFFEE|コーヒー|珈琲|喫茶|咖啡|星巴克|スターバックス|STARBUCKS|ドトール|タリーズ|コメダ|ルノアール)/i, "会議費"],
    [/(居酒屋|焼肉|寿司|鮨|料亭|ダイニング|レストラン|酒場|\bBAR\b)/i, "接待交際費"],
    [/(食堂|ラーメン|そば|うどん|定食|カレー|KITCHEN|DINER|GRILL|RESTAURANT|BISTRO|TRATTORIA|BURGER)/i, "会議費"],
    [/(電気|ガス|水道)/, "水道光熱費"],
    [/(セミナー|研修|講座|受講)/, "研修費"],
    [/(ヨドバシ|ビックカメラ|ヤマダ|ダイソー|セリア|ロフト|LOFT|ハンズ|無印|文具|事務用品|アスクル|ASKUL|AMAZON|アマゾン|ホームセンター|コーナン|カインズ)/i, "消耗品費"],
  ];
  // Item review: score what was bought, not only the shop name.
  const ITEM_RULES = {
    meal: /(定食|丼|ラーメン|そば|蕎麦|うどん|カレー|パスタ|ピザ|寿司|焼き?鳥|餃子|ランチ|ディナー|コース|前菜|サラダ|スープ|ステーキ|ハンバーグ|天ぷら|刺身|お通し|おまかせ|セット|CHICKEN|LAMB|BEEF|PORK|FISH|SALAD|SOUP|CURRY|NOODLE|RICE|PASTA|PIZZA|BURGER|SANDWICH|LUNCH|DINNER|MOMO|DUMPLING|CHAPATI|NAAN|店内|イートイン|名様|人数|テーブル|卓番)/gi,
    alcohol: /(生?ビール|ハイボール|サワー|ワイン|日本酒|焼酎|梅酒|飲み放題|BEER|WINE|SAKE|HIGHBALL|COCKTAIL)/gi,
    cafe: /(コーヒー|珈琲|カフェラテ|ラテ|紅茶|ティー|ケーキ|COFFEE|LATTE|ESPRESSO|CAPPUCCINO|AMERICANO|\bTEA\b)/gi,
    office: /(文具|ノート|ボールペン|ペン|コピー用紙|用紙|インク|トナー|USB|ケーブル|電池|ファイル|封筒|テープ|プリンタ|マウス|キーボード)/gi,
    books: /(書籍|雑誌|新聞|文庫|単行本|BOOK|MAGAZINE)/gi,
    postage: /(切手|はがき|ハガキ|レターパック|郵便|ゆうパック|速達)/g,
  };
  const count = (re, t) => (t.match(re) || []).length;
  // The store name decides first; item lines decide when the name says nothing (a coffee bought at a
  // convenience store is not a meeting, and "Suica" on a café receipt is just how it was paid).
  const TEXT_ONLY_SKIP = new Set(["会議費", "接待交際費", "旅費交通費"]);
  function guessAccount(vendor, t) {
    for (const [re, acc] of ACCOUNT_RULES) if (vendor && re.test(vendor)) return { account: acc, hint: /会議費|接待交際費/.test(acc) ? "meal" : "" };
    const sc = Object.fromEntries(Object.entries(ITEM_RULES).map(([k, re]) => [k, count(re, t)]));
    const reduced = /(※|軽\s*減|8\s*%\s*対象)/.test(t);
    // food & drink eaten in a shop (10% rate, no ※ reduced-rate marks) → meeting or entertainment
    if (sc.meal + sc.alcohol >= 2 && !(reduced && sc.meal <= 2 && !sc.alcohol)) return { account: sc.alcohol ? "接待交際費" : "会議費", hint: "meal" };
    if (sc.cafe >= 1 && !reduced && sc.office === 0) return { account: "会議費", hint: "meal" };
    if (sc.postage >= 1) return { account: "通信費", hint: "" };
    if (sc.books >= 1 && sc.books >= sc.office) return { account: "新聞図書費", hint: "" };
    for (const [re, acc] of ACCOUNT_RULES) if (!TEXT_ONLY_SKIP.has(acc) && re.test(t)) return { account: acc, hint: "" };
    if (/(運賃|乗車|タクシー)/.test(t)) return { account: "旅費交通費", hint: "" };
    // takeout food / groceries (8% reduced rate) are usually personal, so flag them
    if (reduced && sc.office === 0) return { account: "消耗品費", hint: "food8" };
    return { account: "消耗品費", hint: "" };
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
        payment: guessPayment(text), ...(({ account, hint }) => ({ account, hint }))(guessAccount(vendor, text)),
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
      ...(({ account, hint }) => ({ account, hint }))(guessAccount(vendor, text)),
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
  // Find the receipt paper (bright area) in a grey image; returns a crop box or null.
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }
  function paperBox(g, W, H) {
    const st = 4, sw = Math.floor(W / st), sh = Math.floor(H / st), hist = new Array(256).fill(0);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) hist[g[y * st * W + x * st] | 0]++;
    const t = otsu(hist, sw * sh);
    const rowOk = [], colCnt = new Array(sw).fill(0);
    for (let y = 0; y < sh; y++) { let c = 0; for (let x = 0; x < sw; x++) if (g[y * st * W + x * st] > t) { c++; colCnt[x]++; } rowOk.push(c / sw > 0.25); }
    const ys = rowOk.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), xs = colCnt.map((c, i) => (c / sh > 0.25 ? i : -1)).filter((i) => i >= 0);
    if (!ys.length || !xs.length) return null;
    const pad = Math.round(0.01 * Math.max(W, H));
    const x0 = Math.max(0, xs[0] * st - pad), x1 = Math.min(W, (xs[xs.length - 1] + 1) * st + pad);
    const y0 = Math.max(0, ys[0] * st - pad), y1 = Math.min(H, (ys[ys.length - 1] + 1) * st + pad);
    if ((x1 - x0) * (y1 - y0) < 0.12 * W * H) return null; // not confident: keep the whole photo
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }
  // Crop to the paper, enlarge so text is big enough for Tesseract, grey + 1–99% contrast stretch.
  // (Tested on real receipts: hard black/white thresholding hurt thin Latin shop names, so we keep grey.)
  async function prepare(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s0 = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
      const W = Math.round(img.naturalWidth * s0), H = Math.round(img.naturalHeight * s0);
      const c0 = document.createElement("canvas"); c0.width = W; c0.height = H;
      const x0c = c0.getContext("2d", { willReadFrequently: true }); x0c.drawImage(img, 0, 0, W, H);
      const p0 = x0c.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
      for (let i = 0, j = 0; i < p0.length; i += 4, j++) g[j] = 0.299 * p0[i] + 0.587 * p0[i + 1] + 0.114 * p0[i + 2];
      const box = paperBox(g, W, H) || { x0: 0, y0: 0, w: W, h: H };
      // target ~1600 px across the paper; cap total size for phones
      let sc = 1600 / box.w; sc = Math.min(sc, Math.sqrt(16e6 / (box.w * box.h)));
      const c = document.createElement("canvas"); c.width = Math.round(box.w * sc); c.height = Math.round(box.h * sc);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(c0, box.x0, box.y0, box.w, box.h, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data, n = p.length / 4, hist = new Array(256).fill(0);
      const gg = new Uint8ClampedArray(n);
      for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; gg[j] = v; hist[gg[j]]++; }
      let acc = 0, lo = 0, hi = 255;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
      acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
      const k = 255 / Math.max(1, hi - lo);
      for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = (gg[j] - lo) * k; p[i] = p[i + 1] = p[i + 2] = v; }
      ctx.putImageData(d, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  const cleanText = (t) => (t || "").replace(/(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])/g, ""); // drop OCR spaces between CJK chars
  async function readReceipt(blob, opts) {
    progressCb = opts && opts.onProgress;
    // Prefer the original full-resolution photo; fall back to the shrunk copy (e.g. HEIC the browser can't decode).
    let canvas;
    try { canvas = await prepare((opts && opts.original) || blob); } catch (e) { canvas = await prepare(blob); }
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

  const api = { parseReceiptText, readReceipt, normalize, scriptOf, detectCurrency, prepare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
