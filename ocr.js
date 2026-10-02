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
    // A Japanese receipt that shows ¥/円 several times is in yen, whatever stray symbols OCR produced ("£9", "€2")
    const yenMarks = (t.match(/[¥\\]\s*\d|\d\s*円/g) || []).length;
    if (lang === "ja" && yenMarks >= 2) return "JPY";
    if (/(NT\$|新台幣|新臺幣|TWD)/i.test(t)) return "TWD";
    if (/(HK\$|HKD|港幣|港币)/i.test(t)) return "HKD";
    if (/(人民币|人民幣|RMB|CNY)/i.test(t)) return "CNY";
    // a currency sign only counts next to a number (OCR garbage like "S€ffich" is not a euro receipt)
    if (/(US\$\s*\d|\bUSD\b)/i.test(t)) return "USD";
    if (/(€\s*\d|\d\s*€|\bEUR\b)/.test(t)) return "EUR";
    if (/(£\s*\d|\bGBP\b)/.test(t)) return "GBP";
    if (/(₩\s*\d|\bKRW\b|\d\s*원)/.test(t)) return "KRW";
    if (/(\bSGD\b|S\$\s*\d)/.test(t)) return "SGD";
    if (/(円|JPY)/i.test(t)) return "JPY";
    if (lang === "ja") return "JPY";
    if (/\$\s*\d/.test(t) && !/[¥円]/.test(t)) return "USD";
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

  // Any 1–3 non-digit characters between year, month and day (年月日 / - . and their OCR look-alikes:
  // 一 ー ― 午 牛 etc.), plus time/space noise. Candidates near the expected year win.
  function findDate(t, fallbackYear) {
    const pad = (n) => String(n).padStart(2, "0");
    const ok = (y, mo, d) => y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
    const fmt = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;
    const SEP = "[^\\d\\n]{1,3}";
    const texts = [t, t.replace(/(?<=\d) (?=\d)/g, "")]; // OCR sometimes splits digits: "2 0 2 6"
    const cands = [];
    const add = (y, mo, d, prio) => { if (ok(y, mo, d)) cands.push({ y, mo, d, prio }); };
    for (const x of texts) {
      let m, re;
      re = /(?:令和|令|R)\s*(\d{1,2})[^\d\n]{1,3}(\d{1,2})[^\d\n]{1,3}(\d{1,2})/g;          // 令和8年9月20日 / R8.9.20
      while ((m = re.exec(x))) add(2018 + +m[1], +m[2], +m[3], 0);
      re = new RegExp(`(?<!\\d)(20\\d{2})\\s*${SEP}\\s*(\\d{1,2})\\s*${SEP}\\s*(\\d{1,2})(?!\\d)`, "g"); // 2026年9月20日 / 2026-9-20 / 2026/9/20 / 2026.09.20
      while ((m = re.exec(x))) add(+m[1], +m[2], +m[3], 0);
      re = /(?<![\d])['’]?(\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;                // '26年07月30日
      while ((m = re.exec(x))) add(2000 + +m[1], +m[2], +m[3], 1);
      re = /(?<!\d)(20\d{2})\d([^\d\s\n])\s*(\d{1,2})\s*[^\d\n]{1,2}\s*(\d{1,2})(?!\d)/g;      // "20264F7A23H": 年 misread with a stray digit
      while ((m = re.exec(x))) add(+m[1], +m[3], +m[4], 4);
      re = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g;                                          // 20260920
      while ((m = re.exec(x))) add(+m[1], +m[2], +m[3], 2);
      re = /(?:民國|民国)\s*(1\d{2})[^\d\n]{1,3}(\d{1,2})[^\d\n]{1,3}(\d{1,2})/g;             // 民國115年9月20日
      while ((m = re.exec(x))) add(1911 + +m[1], +m[2], +m[3], 0);
      re = /(?<!\d)(1\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})(?!\d)/g;            // 115/09/20 (Taiwan)
      while ((m = re.exec(x))) add(1911 + +m[1], +m[2], +m[3], 3);
      re = /(?<!\d)(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})(?!\d)/g;                          // 09/20/2026 or 20/09/2026
      while ((m = re.exec(x))) { add(+m[3], +m[1], +m[2], 1); add(+m[3], +m[2], +m[1], 2); }
      const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/gi;
      while ((m = re.exec(x))) add(+m[3], MON[m[1].toLowerCase()], +m[2], 0);
      re = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2})/gi;
      while ((m = re.exec(x))) add(+m[3], MON[m[2].toLowerCase()], +m[1], 0);
      re = /(?<!\d)(\d{2})\/(\d{1,2})\/(\d{1,2})(?!\d)/g;                                     // 26/09/20
      while ((m = re.exec(x))) add(2000 + +m[1], +m[2], +m[3], 3);
      re = /(?<!\d)\d(\d)(\d{2})\s*[^\d\n]{1,2}\s*(\d{1,2})\s*[^\d\n]{1,2}\s*(\d{1,2})(?!\d)/g; // "9026/09/20": first digit misread
      while ((m = re.exec(x))) if (m[1] === "0") add(2000 + +m[2], +m[3], +m[4], 4);
      re = /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/g;                                  // inside a transaction no. "…0006 20260902 1245…"
      while ((m = re.exec(x))) add(+m[1], +m[2], +m[3], 6);
      re = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;                                          // 9月20日 (no year)
      while ((m = re.exec(x))) add(fallbackYear, +m[1], +m[2], 5);
    }
    if (!cands.length) return "";
    // prefer plausible years (around the tax year), then the most explicit pattern, then the first one printed
    const near = (c) => Math.abs(c.y - fallbackYear) <= 1;
    cands.sort((a, b) => (near(b) - near(a)) || (a.prio - b.prio));
    const c = cands[0];
    return fmt(c.y, c.mo, c.d);
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
  const NOISE_LINE = /(TEL|電話|FAX|レジ|No[.:]|登録|番号|担当|伝票|責|取引|会員|ポイント|〒)/i;
  const moneyText = (l) => l.replace(/\d+(?:\.\d+)?\s*[%％]/g, " ").replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ");
  // Amounts that look like money: ¥/\ prefix (or OCR's v/w/#), 円 suffix, or thousands separators.
  // Bare numbers (receipt numbers, card numbers, counts) are not money.
  function moneyOnly(l) {
    const x = moneyText(l), out = [];
    let m; const re = /([¥\\￥#vVwW])\s*(\d{1,3}(?:[,.]\s?\d{3})+|\d{2,7})(?![\d])|(?<![\d])(\d{1,3}(?:[,.]\s?\d{3})+|\d{2,7})\s*円|(?<![\d.,])(\d{1,3}(?:,\s?\d{3})+)(?![\d])/g;
    while ((m = re.exec(x))) { const v = toInt(m[2] || m[3] || m[4]); if (v >= 10 && v < 10000000) out.push(v); }
    return out;
  }
  let lastTotalScore = 0;
  function findYenTotal(lines) {
    const info = new Map();
    const add = (v, key) => { if (v < 10 || v >= 10000000) return; const o = info.get(v) || { n: 0, total: 0, excl: 0 }; o.n++; o[key]++; info.set(v, o); };
    for (const l of lines) {
      const isTotal = TOTAL_WORDS.test(l) && !EXCLUDE_WORDS.test(l);
      // dates, times, addresses, phone and register numbers are not money
      if (!isTotal && (DATE_LINE.test(l) || ADDRESS.test(l) || NOISE_LINE.test(l))) continue;
      const isExcl = /(お預|預り|お釣|釣銭|おつり|ポイント|点数|找零)/.test(l);
      // item lines ("¥400 1点 ¥400") repeat item prices; they must not out-vote the total
      if (!isTotal && /\d\s*(点|個|コ|杯|人前)/.test(l)) continue;
      const vals = isTotal ? amountsIn(moneyText(l)) : moneyOnly(l);
      for (const v of new Set(vals)) add(v, isTotal ? "total" : isExcl ? "excl" : "n0");
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
      // v = sum of two or three other amounts (運賃 ¥4,000 + 迎車 ¥500 = ¥4,500)
      const others = vals.filter((a) => a < v);
      let summed = false;
      for (let i = 0; i < others.length && !summed; i++) for (let j = i + 1; j < others.length && !summed; j++) {
        if (near(others[i] + others[j], v)) summed = true;
        for (let k = j + 1; k < others.length && !summed; k++) if (near(others[i] + others[j] + others[k], v)) summed = true;
      }
      if (summed) score += 3;
      // inclusive tax printed: (内消費税 ¥210) where 210 ≈ v*10/110
      for (const t of vals) if (t < v && (near(t, Math.floor(v * 10 / 110)) || near(t, Math.floor(v * 8 / 108)))) { score += 2; break; }
      if (score > bestScore || (score === bestScore && v > best)) { best = v; bestScore = score; }
    }
    lastTotalScore = bestScore;
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

  const ADDRESS = /(〒|東京都|北海道|大阪府|京都府|.{1,3}県|.{1,4}[市区町村].{0,8}\d|TEL|電話|☎|\b\d{3}-\d{4}\b|-KU\b|-SHI\b|-CHO\b|CHOME|[A-Z]+-KU,)/i;
  function vendorOk(l) {
    const s = l.replace(/[|_~=*#<>「」【】()（）\[\]]/g, "").replace(/(?<=[^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, "").replace(/\s+/g, " ").trim();
    if (s.length < 2 || s.length > 30) return "";
    if (/(領収|レシート|receipt|電話|TEL|〒|\d{2,4}-\d{2,4}-\d{3,4}|登録番号|^T\d|^\d)/i.test(s)) return "";
    const letters = (s.match(/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    if (letters / s.replace(/\s/g, "").length < 0.7) return "";
    const cjk = (s.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    if (cjk < 2 && !/[A-Za-z]{3,}/.test(s.replace(/[^A-Za-z]/g, "").length >= 4 ? s : "")) return ""; // "SZ ag", "Sie 2"
    if (/^[ーィッャュョァゥェォ、。・]/.test(s)) return "";
    return s;
  }
  const COMPANY = /(株式会社|有限会社|合同会社|[（(]\s*株\s*[)）]|[（(]\s*有\s*[)）]|Co\.,?\s*Ltd|Inc\.?\b|Corporation)/i;
  // The issuing business (事業者名 / 株式会社… / (株)), which is what the books should record.
  const COMPANY_NAME = /((?:株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人)\s*[^\s　,、。:：|()（）\d]{1,24}|[^\s　,、。:：|()（）\d]{1,24}\s*(?:株式会社|有限会社|合同会社)|[^\s　,、。:：|()（）\d]{1,24}\s*[（(]\s*[株有]\s*[)）]|[A-Za-z][A-Za-z&.' -]{1,40}(?:Co\.,?\s*Ltd\.?|Inc\.?|Corporation|K\.K\.))/i;
  function findCompany(lines) {
    const tidy = (x) => x.replace(/\s+/g, " ").replace(/(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])/g, "").trim();
    // 1) labelled: 事業者名：株式会社ダイナック
    for (const l of lines) {
      const m = l.match(/(?:事業者名|事業者|発行者|発行元|会社名|運営会社|販売元|販売者|社名)(?!印)\s*(?:[:：]|\s)\s*(.+)$/);
      if (m) {
        const v = tidy(m[1].replace(/(TEL|電話|〒|登録番号).*$/i, ""));
        if (v.length >= 2 && plausibleName(cleanName(v))) return v.slice(0, 40);
      }
    }
    // 2) a company name anywhere; closest to the 登録番号 line wins
    const reg = lines.findIndex((l) => /登録番号|T\d{13}/.test(l.replace(/\s/g, "")));
    const found = [];
    lines.forEach((l, i) => {
      const m = l.match(COMPANY_NAME);
      if (!m) return;
      const v = tidy(m[1]);
      const core = cleanName(v.replace(/株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|[（(]\s*[株有]\s*[)）]|Co\.,?\s*Ltd\.?|Inc\.?|Corporation|K\.K\./gi, " "));
      const latinForm = /(Co\.,?\s*Ltd|Inc\.?|Corporation|K\.K\.)/i.test(v);
      const cjk = (core.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
      if ((cjk >= 2 && plausibleName(core)) || (latinForm && /[A-Za-z]{3,}/.test(core))) found.push({ v, d: reg >= 0 ? Math.abs(i - reg) : i });
    });
    // OCR often drops the brackets of "(株)": "東京リスマチック株"
    if (!found.length) lines.forEach((l, i) => {
      const m = l.replace(/\s/g, "").match(/([\u30a0-\u30ff\u4e00-\u9fff]{3,20})株$/);
      if (m && plausibleName(m[1])) found.push({ v: m[1] + "（株）", d: reg >= 0 ? Math.abs(i - reg) : i });
    });
    found.sort((a, b) => a.d - b.d);
    return found.length ? found[0].v.slice(0, 40) : "";
  }

  function findVendor(lines) {
    const head = lines.slice(0, 12);
    const ai = head.findIndex((l) => ADDRESS.test(l));
    for (let i = ai - 1; ai > 0 && i >= Math.max(0, ai - 3); i--) {
      const v = vendorOk(head[i]);
      if (!v) continue;
      // two-line names: "DEAN & DELUCA" / "カフェ渋谷ストリーム店"
      const up = i > 0 ? vendorOk(head[i - 1]) : "";
      if (up && /[店舗館]$|店\s*$|BRANCH/i.test(v) && !/(領\s*収|レシート|RECEIPT)/i.test(head[i - 1])) return (up + " " + v).slice(0, 40);
      return v;
    }
    const ri = head.findIndex((l) => /(領\s*収\s*[書証]|レシート|RECEIPT)/i.test(l));
    for (let i = ri + 1; ri >= 0 && i <= Math.min(head.length - 1, ri + 2); i++) { const v = vendorOk(head[i]); if (v) return v; }
    // logo unreadable: use the company line (often printed at the bottom)
    const co = lines.find((l) => COMPANY.test(l) && vendorOk(l) && plausibleName(cleanName(l.replace(COMPANY, " "))));
    if (co) return vendorOk(co);
    for (const l of lines.slice(0, 8)) { const v = vendorOk(l); if (v) return v; }
    return "";
  }


  const ACCOUNT_RULES = [
    [/(タクシー|交通|JR|鉄道|駅|乗車|SUICA|PASMO|ICOCA|バス|新幹線|航空|高速|駐車|パーキング|ガソリン|ENEOS|出光|コスモ石油)/i, "旅費交通費"],
    [/(郵便|切手|レターパック|ゆうパック|携帯|docomo|ドコモ|KDDI|au by|softbank|ソフトバンク|楽天モバイル|通信料|月額プラン|年額プラン|サブスク|SUBSCRIPTION|ADOBE|CREATIVE CLOUD|GOOGLE WORKSPACE|MICROSOFT 365|OFFICE 365|AWS|AMAZON WEB SERVICES|さくらインターネット|エックスサーバー|XSERVER|お名前\.com|ドメイン|サーバー|CHATGPT|OPENAI|ANTHROPIC|CLAUDE|CANVA|ZOOM|SLACK|NOTION|DROPBOX|FIGMA)/i, "通信費"],
    [/(ヤマト|佐川|宅急便|宅配|運輸)/, "荷造運賃"],
    [/(書店|書房|ブック|BOOK|紀伊國屋|丸善|ジュンク|蔦屋|TSUTAYA|新聞)/i, "新聞図書費"],
    [/(収入印紙|印紙)/, "租税公課"],
    [/(振込手数料|手数料)/, "支払手数料"],
    [/(カフェ|CAFE|CAFÉ|COFFEE|コーヒー|珈琲|喫茶|咖啡|星巴克|スターバックス|STARBUCKS|ドトール|タリーズ|コメダ|ルノアール)/i, "会議費"],
    [/(居酒屋|焼肉|寿司|鮨|料亭|ダイニング|レストラン|酒場|\bBAR\b)/i, "接待交際費"],
    [/(食堂|ラーメン|そば|うどん|定食|カレー|和食|洋食|中華|鉄板|割烹|ビストロ|トラットリア|バーガー|ハンバーグ|とんかつ|天ぷら|KITCHEN|DINER|GRILL|RESTAURANT|BISTRO|TRATTORIA|BURGER|TAPROOM|DINING)/i, "会議費"],
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
  // ---------- 摘要 (summary label, Japanese) and item list ----------
  // A short generic label for the 摘要 column, chosen from the account and what the receipt says.
  function summaryFor(account, text) {
    const t = String(text || "");
    const by = (pairs, dflt) => { for (const [re, label] of pairs) if (re.test(t)) return label; return dflt; };
    switch (account) {
      case "会議費": return by([[/(コーヒー|珈琲|カフェ|COFFEE|CAFE|ラテ|紅茶)/i, "打合せ喫茶代"]], "打合せ飲食代");
      case "接待交際費": return by([[/(贈答|ギフト|お中元|お歳暮|花束|手土産)/, "贈答品代"], [/(慶弔|香典|祝儀)/, "慶弔費"]], "接待飲食代");
      case "旅費交通費": return by([[/タクシー|TAXI|運賃/i, "タクシー代"], [/新幹線/, "新幹線代"], [/(航空|AIR|ANA|JAL|PEACH)/i, "航空券代"], [/(ホテル|HOTEL|宿泊|旅館)/i, "宿泊費"], [/(駐車|パーキング|PARKING)/i, "駐車場代"], [/(ガソリン|ENEOS|出光|コスモ)/i, "ガソリン代"], [/(高速|ETC)/i, "高速道路代"], [/(JR|鉄道|電車|SUICA|PASMO|ICOCA|乗車券|定期)/i, "電車代"], [/バス/, "バス代"]], "交通費");
      case "通信費": return by([[/(切手|はがき|ハガキ|レターパック|郵便|ゆうパック)/, "郵送料"], [/(携帯|スマホ|docomo|ドコモ|softbank|楽天モバイル|KDDI)/i, "携帯電話料金"], [/(光回線|インターネット|プロバイダ|Wi-?Fi)/i, "インターネット料金"], [/(サーバー|ドメイン|XSERVER|さくら|AWS)/i, "サーバー・ドメイン代"]], /(月額|年額|サブスク|SUBSCRIPTION|ADOBE|GOOGLE|MICROSOFT|CHATGPT|OPENAI|CLAUDE|CANVA|ZOOM|SLACK|NOTION|DROPBOX|FIGMA)/i.test(t) ? "ソフトウェア利用料" : "通信費");
      case "消耗品費": return by([[/(文具|ボールペン|ノート|コピー用紙|用紙|インク|トナー|ファイル|封筒|テープ)/, "事務用品代"], [/(USB|ケーブル|マウス|キーボード|電池|充電)/i, "PC周辺機器"], [/(洗剤|ティッシュ|トイレット|清掃)/, "日用品代"]], "消耗品代");
      case "新聞図書費": return by([[/新聞/, "新聞代"], [/雑誌/, "雑誌代"]], "書籍代");
      case "支払手数料": return by([[/振込/, "振込手数料"], [/(決済|カード)/, "決済手数料"]], "支払手数料");
      case "水道光熱費": return by([[/電気/, "電気代"], [/ガス/, "ガス代"], [/水道/, "水道代"]], "水道光熱費");
      case "荷造運賃": return "配送料";
      case "広告宣伝費": return "広告宣伝費";
      case "地代家賃": return by([[/(駐車場|パーキング)/, "駐車場賃料"], [/(コワーキング|シェアオフィス)/, "コワーキング利用料"]], "家賃");
      case "租税公課": return by([[/印紙/, "収入印紙代"]], "租税公課");
      case "研修費": return "セミナー参加費";
      case "修繕費": return "修理代";
      case "損害保険料": return "保険料";
      case "外注工賃": return "外注費";
      case "仕入高": return "商品仕入";
      default: return account || "";
    }
  }

  // Item lines between the header and the 小計/合計 block: "Chicken MOMO ×1", "おにぎり ×2" …
  const ITEM_STOP = /(小\s*計|小计|合\s*計|合计|総\s*計|總\s*計|お?買\s*上|お会計|ご?請求|SUB\s*TOTAL|TOTAL|お預|お釣|対象|消費税|内税|外税)/i;
  const ITEM_SKIP = /(領\s*収|レシート|RECEIPT|TEL|電話|〒|登録番号|レジ|担当|取引|No[.:]|伝票|ご利用|ありがとう|お待ち|またの|お越し|営業時間|店|様|^\s*\d+\s*[/.-]\s*\d+|品目|数量|金額|単価|発行日|お支払|支払方法|カード|現金)/i;
  const DATE_LINE = /((?<!\d)(20\d{2}|令和\s*\d{1,2}|R\s*\d{1,2})\s*[^\d\n]{1,3}\s*\d{1,2}\s*[^\d\n]{1,3}\s*\d{1,2}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})/i;
  function cleanName(l) {
    let n = l.replace(/[¥\\￥$]\s*[\d,.\s]*\d|\d[\d,]*\s*円|\d+\.\d{1,2}|[×xX＊*]\s*\d+|\d+\s*(?:点|個|コ|本|枚|杯|人前|名)|[※★◆●○■□()（）\[\]{}|<>~=_]/g, " ")
      .replace(/(^|\s)\d{1,4}(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
    // OCR junk: drop trailing 1–2 letter Latin fragments ("Butter MOMO ua" → "Butter MOMO")
    n = n.replace(/(\s+[A-Za-z]{1,2})+$/, "").trim();
    return n;
  }
  function plausibleName(n) {
    const compact = n.replace(/\s/g, "");
    if (compact.length < 2 || compact.length > 30) return false;
    const cjk = (compact.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    const latin = (compact.match(/[A-Za-z]/g) || []).length;
    if ((cjk + latin) / compact.length < (cjk >= 2 ? 0.5 : 0.7)) return false;
    if (cjk < 2 && cjk + latin < 3) return false; // "j 点", "AE"…
    if (/[%％]|税|計|預|釣|点数|合算|対象/.test(n)) return false;          // summary lines, not items
    if (/^[ーィッャュョァゥェォ、。・ヽ]/.test(n)) return false;            // OCR fragments
    if (!cjk && !n.split(/\s+/).some((w) => w.length >= 4 && /[aeiouy]/i.test(w))) return false; // "LAR", "Hi HI OFA"
    if (!cjk && !/[A-Za-z]{3,}/.test(n)) return false; // Latin needs a real word
    return true;
  }
  // A price on a line: ¥/円/$ amounts, comma numbers, or a trailing number (not %, not times).
  function priceOf(l) {
    const x = moneyText(l);
    const vals = [];
    let m; const re = /(?:[¥\\￥$]\s*(\d{1,3}(?:[,.]\s?\d{3})+|\d+)(?:\.\d{1,2})?)|(?:(\d{1,3}(?:,\d{3})+|\d+)\s*円)|(?:(?<![\d.])(\d{1,3}(?:,\d{3})+)(?![\d]))/g;
    while ((m = re.exec(x))) { const v = toInt(m[1] || m[2] || m[3]); if (v >= 10) vals.push(v); }
    if (!vals.length) { const e = x.match(/\s(\d{2,7})(?:\.\d{1,2})?\s*$/); if (e && +e[1] >= 10) vals.push(+e[1]); }
    return vals.length ? Math.max(...vals) : 0;
  }
  function qtyOf(l) {
    const all = [];
    let m; const re = /[×xX＊*]\s*(\d{1,3})(?!\d)|(\d{1,3})\s*(点|個|コ|本|杯|人前|名|枚|袋|箱)/g;
    while ((m = re.exec(l))) { const v = +(m[1] || m[2]); if (v >= 1 && v <= 99 && !(m[3] === "枚" && v > 20)) all.push(v); }
    if (all.length) return all[all.length - 1];
    const s2 = l.match(/\s(\d{1,2})\s*[=:・\-－_.,]?\s+[¥\\￥]?\s*\d[\d,]*\s*円?\s*$/); // "ブレンドコーヒー 2 ¥1,240" (OCR may add "=")
    return s2 ? +s2[1] : null;
  }
  // Items = lines after the date with a name AND a price (same line, or a price-only line just below),
  // up to the 小計/合計 block. Lines without a price (greetings, addresses, register info) are ignored.
  function extractItems(lines, vendor, total) {
    const di = lines.findIndex((l) => DATE_LINE.test(l));
    const out = [];
    let sum = 0;
    const nameOf = (l) => { const n = cleanName(l); return plausibleName(n) && !ITEM_SKIP.test(n) && n !== vendor && !ADDRESS.test(l) && !NOISE_LINE.test(l) ? n : ""; };
    for (let i = di >= 0 ? di + 1 : 1; i < lines.length && out.length < 15; i++) {
      const l = lines[i].trim();
      if (ITEM_STOP.test(l)) { if (out.length) break; continue; }
      const price = priceOf(l), name = nameOf(l);
      // reached the subtotal / total even if its label was garbled by OCR
      if (out.length >= 2 && price && ((total && price === total) || Math.abs(price - sum) <= Math.max(1, sum * 0.1))) break;
      if (!name) continue;
      let qty = qtyOf(l), p = price;
      if (!p && i + 1 < lines.length) {
        const nx = lines[i + 1].trim();
        if (!nameOf(nx) && !ITEM_STOP.test(nx)) { p = priceOf(nx); if (p) { qty = qty || qtyOf(nx); i++; } }
      }
      if (!p) continue; // no price → not a purchased item
      out.push(name + (qty ? "×" + qty : ""));
      sum += p;
    }
    return out;
  }


  function parseReceiptText(raw, opts) {
    const year = (opts && opts.year) || new Date().getFullYear();
    const text = normalize(raw);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const lang = (opts && opts.lang) || scriptOf(text);
    const currency = detectCurrency(text, lang) || "JPY";
    if (currency !== "JPY") {
      // Overseas purchase: amounts are not yen and are outside Japanese consumption tax.
      const date = findDate(text, year), store = findVendor(lines), company = findCompany(lines), vendor = company || store;
      const acc = guessAccount(store + " " + vendor + " " + lines.slice(0, 5).join(" "), text);
      return {
        date: date || null, vendor, store, company, invoice_no: null, items: summaryFor(acc.account, text), item_list: extractItems(lines, store, 0),
        amount_10: 0, amount_8: 0, amount_other: 0, total: 0,
        foreign_total: findTotal(lines, true), currency, language: lang,
        payment: guessPayment(text), ...(({ account, hint }) => ({ account, hint }))(guessAccount(store + " " + vendor + " " + lines.slice(0, 5).join(" "), text)),
        confidence: "low", notes: "",
      };
    }
    lastTotalScore = 0;
    const total = findTotal(lines);
    const totalScore = lastTotalScore;
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
    const store = findVendor(lines), company = findCompany(lines), vendor = company || store;
    const found = [total > 0, !!date, !!findInvoiceNo(text)].filter(Boolean).length;
    return {
      date: date || null,
      vendor, store, company, total_score: totalScore,
      invoice_no: findInvoiceNo(text) || null,
      items: summaryFor(guessAccount(store + " " + vendor + " " + lines.slice(0, 5).join(" "), text).account, text), item_list: extractItems(lines, store, total),
      amount_10: a10, amount_8: a8, amount_other: other, total,
      payment: guessPayment(text),
      ...(({ account, hint }) => ({ account, hint }))(guessAccount(store + " " + vendor + " " + lines.slice(0, 5).join(" "), text)),
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
  async function prepare(blob, mode) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s0 = Math.min(1, 4200 / Math.max(img.naturalWidth, img.naturalHeight));
      const W = Math.round(img.naturalWidth * s0), H = Math.round(img.naturalHeight * s0);
      const c0 = document.createElement("canvas"); c0.width = W; c0.height = H;
      const x0c = c0.getContext("2d", { willReadFrequently: true }); x0c.drawImage(img, 0, 0, W, H);
      const p0 = x0c.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
      for (let i = 0, j = 0; i < p0.length; i += 4, j++) g[j] = 0.299 * p0[i] + 0.587 * p0[i + 1] + 0.114 * p0[i + 2];
      const box = paperBox(g, W, H) || { x0: 0, y0: 0, w: W, h: H };
      // target ~1600 px across the paper; cap total size for phones
      // Keep the photo's own resolution (small print on big statements needs it), but at least
      // 1600 px across the paper so small receipts are enlarged, and at most 2800 px / 16 MP for phones.
      // "standard": 1600 px across the paper (best for ordinary receipts);
      // "full": keep the photo's own resolution (for small print on large statements), 1600–2800 px.
      let sc = (mode === "full" ? Math.max(1600, Math.min(box.w, 2800)) : 1600) / box.w;
      sc = Math.min(sc, Math.sqrt(16e6 / (box.w * box.h)));
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
    const src = (opts && opts.original) || blob;
    const prep = async (mode) => { try { return await prepare(src, mode); } catch (e) { return await prepare(blob, mode); } };
    const read = async (canvas) => {
      // Japanese + English covers almost every receipt issued in Japan; re-read with the right models
      // when the receipt is Chinese or English.
      let text = cleanText((await (await getWorker("jpn+eng")).recognize(canvas)).data.text);
      const lang = scriptOf(text);
      if (PASS2[lang]) {
        if (opts && opts.onLanguage) opts.onLanguage(lang);
        try { text = cleanText((await (await getWorker(PASS2[lang])).recognize(canvas)).data.text); } catch (e) { /* keep first text */ }
      }
      const r = parseReceiptText(text, { ...(opts || {}), lang });
      r.raw_text = text;
      return r;
    };
    let r = await read(await prep("standard"));
    // Small print (large statements, company lines): read again at full resolution and fill the gaps.
    if (needsSecondPass(r)) {
      if (opts && opts.onSecondPass) opts.onSecondPass();
      try {
        const r2 = await read(await prep("full"));
        r = { ...mergeResults(r, r2), raw_text: r.raw_text + "\n" + r2.raw_text };
      } catch (e) { /* keep the first result */ }
    }
    return r;
  }

  // A first read at the standard size can miss small print. When date, total or company is missing,
  // a second read at full resolution fills the gaps (never overrides what the first read found).
  const needsSecondPass = (r) => !r.date || (!r.total && !r.foreign_total) || !r.company || (r.total && (r.total_score || 0) < 4);
  function mergeResults(a, b) {
    const out = { ...a };
    if (!a.date && b.date) out.date = b.date;
    if (b.total && a.currency === b.currency && (!a.total || (b.total_score || 0) > (a.total_score || 0) + 1)) { out.total = b.total; out.amount_10 = b.amount_10; out.amount_8 = b.amount_8; out.amount_other = b.amount_other; }
    if (!a.company && b.company) { out.company = b.company; out.vendor = b.company; }
    if (!out.store && b.store) out.store = b.store;
    if (!a.invoice_no && b.invoice_no) out.invoice_no = b.invoice_no;
    if ((!a.item_list || !a.item_list.length) && b.item_list && b.item_list.length) out.item_list = b.item_list;
    if (a.payment === "unknown" && b.payment !== "unknown") out.payment = b.payment;
    if (!a.foreign_total && b.foreign_total) out.foreign_total = b.foreign_total;
    const found = [out.date, out.total || out.foreign_total, out.company].filter(Boolean).length;
    if (found >= 2 && out.confidence === "low") out.confidence = "medium";
    return out;
  }

  const api = { needsSecondPass, mergeResults, parseReceiptText, readReceipt, normalize, scriptOf, detectCurrency, prepare, summaryFor, extractItems };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptOCR = api;
})(typeof window !== "undefined" ? window : globalThis);
