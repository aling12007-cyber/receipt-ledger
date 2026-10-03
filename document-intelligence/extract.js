// Receipt Ledger — Document Intelligence: structured extraction of a Japanese receipt / invoice.
// Builds the Extraction (DocModel) from OCR text + lines (with boxes) and the receipt reader's result:
// date, merchant, address, phone, 登録番号 + status, receipt no., items, subtotal, discount, total,
// tax breakdown per rate (10% / 8% / 非課税 / 不課税 / 免税, 税込 or 税抜), payment method.
// Every field keeps where it was read (bbox) and how certain the reading is; corrected characters lower it.
// Exposes window.DocExtract (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const M = isNode ? require("./model.js") : root.DocModel;
  const D = isNode ? require("./digits.js") : root.DocDigits;
  const K = isNode ? require("./classify.js") : root.DocClassify;
  /* eslint-enable no-undef */

  const compact = (s) => D.toHalf(String(s || "")).replace(/[\s　]/g, "").toLowerCase();
  const PREF = /(北海道|東京都|(?:京都|大阪)府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県|〒\s*\d{3}-?\d{4})/;

  /**
   * @param {{ text: string, lines?: Array<{ text: string, confidence: number, bbox: any }>, r?: any, year?: number, readingConfidence?: number, docType?: string }} input
   */
  function extract(input) {
    const text = String(input.text || "");
    const r = input.r || {};
    const year = input.year || new Date().getFullYear();
    const base = input.readingConfidence ?? 0.75;
    const tl = D.toHalf(text).split("\n").map((l) => l.trim()).filter(Boolean);
    const ocrLines = (input.lines || []).map((l) => ({ ...l, key: compact(l.text) }));
    const e = M.emptyExtraction();
    e.rawText = text;

    /** OCR line (box, confidence) for text line i. */
    const boxOf = (i) => {
      if (i < 0 || !ocrLines.length) return { bbox: null, confidence: base };
      const k = compact(tl[i]);
      const hit = ocrLines.find((l) => l.key === k) || ocrLines.find((l) => k.length >= 3 && (l.key.includes(k) || k.includes(l.key)) && l.key.length >= 3);
      return hit ? { bbox: hit.bbox, confidence: hit.confidence } : { bbox: null, confidence: base };
    };
    const lineWith = (re, from = 0, to = tl.length) => { for (let i = from; i < Math.min(to, tl.length); i++) if (re.test(tl[i])) return i; return -1; };
    const fieldAt = (value, i, o = {}) => {
      const b = boxOf(i);
      let c = b.confidence * (o.labelled === false ? 0.85 : 1) * (o.corrected && o.corrected.length ? 0.85 : 1);
      if (value == null || value === "") c = 0;
      return M.field(value, { confidence: c, bbox: b.bbox, source: o.source || (i >= 0 ? "ocr-line" : "reader"), raw: i >= 0 ? tl[i] : undefined, corrected: o.corrected });
    };

    // ---- document type ----
    const cls = K.classify(text);
    e.documentType = M.field(input.docType || cls.type, { confidence: cls.confidence, source: "classifier" });

    // ---- date ----
    const d = D.date(text, year);
    e.issueDate = d.value ? fieldAt(d.value, d.line, { corrected: d.corrected }) : M.field(r.date || null, { confidence: r.date ? base * 0.8 : 0, source: "reader" });

    // ---- merchant, address, phone, receipt no. ----
    const merchant = r.vendor || r.company || r.store || "";
    const mi = merchant ? tl.findIndex((l) => compact(l).includes(compact(merchant).slice(0, 6))) : -1;
    e.merchantName = fieldAt(merchant || null, mi, { labelled: mi >= 0 });
    e.rawMerchantName = M.field(r.store || merchant || null, { confidence: e.merchantName.confidence, bbox: e.merchantName.bbox, source: "ocr-line" });
    const ai = lineWith(PREF, 0, 15);
    e.merchantAddress = ai >= 0 ? fieldAt(tl[ai].replace(/^(住所|所在地)[:：]?\s*/, ""), ai) : M.field(null);
    const pi = lineWith(/(TEL|Tel|tel|電話|☎|℡)\s*[:：.]?\s*0\d|(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)/, 0, 20);
    if (pi >= 0) { const m = tl[pi].match(/0\d{1,4}[-(（ ]?\d{1,4}[-)） ]?\d{3,4}/); e.phoneNumber = fieldAt(m ? m[0].replace(/[（(]/g, "-").replace(/[)）\s]/g, "-").replace(/-+/g, "-") : null, pi); }
    const ri = lineWith(/(レシート|伝票|取引|領収書|領収証|注文|会計)\s*(No|NO|番号|#)|(^|\s)(No|NO)\s*[.:：]\s*\d/);
    if (ri >= 0) { const m = tl[ri].match(/(?:No|NO|番号|#)\s*[.:：]?\s*([A-Z0-9][A-Z0-9-]{2,})/); if (m) e.receiptNumber = fieldAt(m[1], ri); }

    // ---- 登録番号 ----
    const corporate = /株式会社|有限会社|合同会社|\(株\)|（株）/.test(merchant + " " + tl.slice(0, 6).join(" "));
    const inv = D.invoice(text, { corporate });
    e.invoiceRegistrationNumber = inv.value ? fieldAt(inv.value, inv.line, { corrected: inv.corrected }) : M.field(null, { confidence: 0 });
    e.invoiceStatus = M.field(inv.status, { confidence: inv.status === "registered" ? e.invoiceRegistrationNumber.confidence : inv.status === "not_found" ? 0.7 : 0.4, source: "invoice-parser" });
    e.invoiceCheck = { checkDigit: inv.checkDigit || "n/a", corrected: inv.corrected };

    // ---- amounts: total, subtotal, discount ----
    let total = Number(r.total) || null;
    let tenderedFix = false;
    /** @type {{ value: number, line: number } | null} */
    let labelledTotal = null;
    // the reader can take the cash handed over (お預り / 現金 ¥6,000) for the total: a 合計 line that, with the change,
    // explains it (or equals the subtotal) wins
    {
      const li = tl.findIndex((l) => /(合\s*計|お会計|ご請求金額|御請求金額|領収金額|お買上計)/.test(l) && !/小\s*計/.test(l) && D.amountsIn(l).length);
      if (li >= 0) {
        const as = D.amountsIn(tl[li]), A = Math.abs(as[as.length - 1].value);   // "合計 -¥8,740": the dash is a separator
        const ci = tl.findIndex((l) => /(お釣|おつり|釣銭|^お.り\s*[¥\\\d])/.test(l) && D.amountsIn(l).length);
        const change = ci >= 0 ? D.amountsIn(tl[ci]).slice(-1)[0].value : null;
        const si0 = tl.findIndex((l) => /小\s*計/.test(l) && D.amountsIn(l).length);
        const sub0 = si0 >= 0 ? D.amountsIn(tl[si0]).slice(-1)[0].value : null;
        const tendered = total != null && tl.some((l) => /(現金|お預|預り|お支払|CASH)/i.test(l) && D.amountsIn(l).some((a) => Math.abs(a.value) === total));
        if (A > 0 && A !== total && ((change != null && total != null && total - change === A) || (sub0 === A && tendered) || (total == null))) { total = A; tenderedFix = r.total != null; }
        else if (A > 0 && A !== total) labelledTotal = { value: A, line: li };
      }
    }
    let ti = -1;
    if (total) {
      const hits = tl.map((l, i) => ({ i, l })).filter(({ l }) => D.amountsIn(l).some((a) => Math.abs(a.value) === total));
      const lab = hits.find(({ l }) => /合\s*計|お会計|ご請求金額|御請求金額|領収金額|お買上|総額|TOTAL/i.test(l)) || hits[0];
      ti = lab ? lab.i : -1;
      const corr = ti >= 0 ? (D.amountsIn(tl[ti]).find((a) => Math.abs(a.value) === total) || { corrected: [] }).corrected : [];
      e.total = fieldAt(total, ti, { labelled: !!(lab && /合\s*計|お会計|請求金額|領収金額|お買上|総額|TOTAL/i.test(lab.l)), corrected: tenderedFix ? [...corr, "tendered-excluded"] : corr });
      // the line labelled 合計 says something else: keep it (with its box) so the re-read and the arithmetic can decide
      if (labelledTotal) { const b = boxOf(labelledTotal.line); e.total.alternatives = [{ value: labelledTotal.value, bbox: b.bbox, source: "total-label" }]; e.total.confidence = Math.min(e.total.confidence, 0.6); }
    }
    const lastAmount = (i) => { const as = D.amountsIn(tl[i]); return as.length ? { ...as[as.length - 1], value: Math.abs(as[as.length - 1].value) } : null; };
    const si = lineWith(/小\s*計|小计|SUB\s*TOTAL/i);
    if (si >= 0) { const a = lastAmount(si); if (a) e.subtotal = fieldAt(a.value, si, { corrected: a.corrected }); }
    let discount = 0, di = -1;
    tl.forEach((l, i) => { if (/(値引|割引|クーポン|ポイント(利用|値引|充当)|ディスカウント|\bOFF\b)/i.test(l)) { const a = lastAmount(i); if (a) { discount += Math.abs(a.value); di = di < 0 ? i : di; } } });
    if (discount) e.discount = fieldAt(discount, di);

    // ---- 消費税: per rate, 非課税 / 不課税 / 免税, 税込 / 税抜 ----
    const exclusive = /(外税|税抜|税別|外消費税|本体価格)/.test(text);
    const inclusiveMark = /(内税|内消費税|税込|内\s*\d+\s*%)/.test(text);
    /** @type {Record<string, any>} */
    const rates = {};
    const slot = (key, rate, category) => (rates[key] = rates[key] || { rate, category, taxableAmount: null, taxAmount: null, lines: [], corrected: [] });
    tl.forEach((l, i) => {
      const as = D.amountsIn(l);
      if (!as.length) return;
      const rm = l.match(/(10|8)\s*%/), reduced = /軽\s*減/.test(l);
      const rate = rm ? Number(rm[1]) : reduced ? 8 : null;
      const isBase = /対象|課税(計|額|対象)?(?!.*税額)/.test(l) && !/非課税|不課税|対象外/.test(l);
      const isTax = /(内?消費税(等|額)?|内税|外税|税額|(?<![非不免課])税\s*[¥\d(（])/.test(l) && !/非課税|不課税|免税/.test(l);
      if (/非\s*課\s*税/.test(l)) { const s = slot("nontaxable", 0, "nontaxable"); s.taxableAmount = (s.taxableAmount || 0) + as[as.length - 1].value; s.lines.push(i); return; }
      if (/不\s*課\s*税|課税対象外|対象外/.test(l)) { const s = slot("outside", 0, "outside"); s.taxableAmount = (s.taxableAmount || 0) + as[as.length - 1].value; s.lines.push(i); return; }
      if (/免\s*税/.test(l)) { const s = slot("exempt", 0, "exempt"); s.taxableAmount = (s.taxableAmount || 0) + as[as.length - 1].value; s.lines.push(i); return; }
      // amounts after the rate (the "10%" itself is not one)
      const after = rm ? as.filter((a) => a.index > l.indexOf(rm[0])) : as;
      const fits = (base0, tax0) => Math.abs(tax0 - (base0 * rate) / (100 + rate)) <= 1 || Math.abs(tax0 - (base0 * rate) / 100) <= 1;
      // "(10%対象 ¥5,500 内税 ¥500)": base and tax on one line. Labels are often misread ("対象" → "xt"), so two amounts
      // that fit the rate are taken as base + tax even without the label; with both labels they are taken anyway (validation checks them).
      if (rate && after.length >= 2 && ((isBase && isTax) || ((isBase || isTax || /[(（]/.test(l)) && fits(after[0].value, after[1].value)))) {
        const s = slot(String(rate), rate, rate === 8 ? "reduced" : "standard");
        s.taxableAmount = after[0].value; s.taxAmount = after[1].value; s.lines.push(i); s.corrected.push(...after[0].corrected, ...after[1].corrected);
        if (!(isBase && isTax)) s.corrected.push("label-misread");
        return;
      }
      if (rate && isBase && after.length) { const s = slot(String(rate), rate, rate === 8 ? "reduced" : "standard"); s.taxableAmount = after[0].value; s.lines.push(i); s.corrected.push(...after[0].corrected); return; }
      if (rate && isTax) { const s = slot(String(rate), rate, rate === 8 ? "reduced" : "standard"); s.taxAmount = as[as.length - 1].value; s.lines.push(i); s.corrected.push(...as[as.length - 1].corrected); return; }
      if (!rate && /消費税等|消費税合計|税額合計|^\(?\s*(内\s*)?消費税\s*[¥\d]/.test(l)) e._taxTotalLine = { value: as[as.length - 1].value, line: i, corrected: as[as.length - 1].corrected };
    });
    /** @type {any[]} */
    const breakdown = Object.values(rates).map((s) => {
      const b = boxOf(s.lines[0]);
      return { rate: s.rate, category: s.category, taxableAmount: s.taxableAmount, taxAmount: s.taxAmount, inclusive: !exclusive,
        bbox: b.bbox, confidence: b.confidence * (s.corrected.length ? 0.85 : 1), source: "ocr-line", raw: s.lines.map((i) => tl[i]) };
    });
    // no printed breakdown: derive it from the reader's 10% / 8% / other split (marked as derived)
    if (!breakdown.length && total) {
      const a10 = Number(r.amount_10) || 0, a8 = Number(r.amount_8) || 0, a0 = Number(r.amount_other) || 0;
      // all 10% with no sign of reduced-rate items (※ 軽 8%) is the usual case and fairly safe; anything else is a guess
      const plain10 = a10 === total && !/※|軽\s*減|8\s*%|\*\s*印/.test(text);
      if (a10) breakdown.push({ rate: 10, category: "standard", taxableAmount: a10, taxAmount: Math.floor((a10 * 10) / 110), inclusive: true, bbox: null, confidence: base * (plain10 ? 0.97 : 0.7), source: "derived" });
      if (a8) breakdown.push({ rate: 8, category: "reduced", taxableAmount: a8, taxAmount: Math.floor((a8 * 8) / 108), inclusive: true, bbox: null, confidence: base * 0.7, source: "derived" });
      if (a0) breakdown.push({ rate: 0, category: "nontaxable", taxableAmount: a0, taxAmount: 0, inclusive: true, bbox: null, confidence: base * 0.7, source: "derived" });
    }
    e.taxBreakdown = breakdown.sort((a, b) => b.rate - a.rate);
    e.taxInclusive = exclusive ? false : inclusiveMark ? true : null;   // null: not printed; validation infers it from the arithmetic
    const rateTax = breakdown.filter((b) => b.rate && b.taxAmount != null && b.source !== "derived").reduce((s, b) => s + b.taxAmount, 0);
    if (e._taxTotalLine) e.taxTotal = fieldAt(e._taxTotalLine.value, e._taxTotalLine.line, { corrected: e._taxTotalLine.corrected });
    else if (rateTax) e.taxTotal = M.field(rateTax, { confidence: Math.min(...breakdown.filter((b) => b.taxAmount != null).map((b) => b.confidence)), source: "sum-of-rates" });
    delete e._taxTotalLine;

    // ---- items ----
    e.items = (r.item_details || []).map((it) => ({
      name: it.name, quantity: it.qty || 1, unitPrice: it.qty > 1 ? Math.round(it.price / it.qty) : it.price, amount: it.price,
      taxRate: it.reduced ? 8 : 10, taxCategory: it.reduced ? "reduced" : "standard", bbox: null, confidence: base * 0.8,
    }));
    for (const it of e.items) { const i = tl.findIndex((l) => compact(l).includes(compact(it.name)) && D.amountsIn(l).some((a) => a.value === it.amount)); if (i >= 0) { const b = boxOf(i); it.bbox = b.bbox; it.confidence = b.confidence; } }

    // ---- payment, currency ----
    const pay = r.payment || "unknown";
    const payLine = lineWith(pay === "card" ? /クレジット|CREDIT|VISA|MASTER|JCB|AMEX|カード/i : pay === "emoney" ? /電子マネー|SUICA|PASMO|PAYPAY|QUICPAY|iD|WAON|NANACO|EDY/i : pay === "cash" ? /現金|お預|預り|CASH/i : /$^/);
    e.paymentMethod = fieldAt(pay === "unknown" ? null : pay, payLine);
    e.currency = M.field(r.currency || "JPY", { confidence: 0.9, source: "reader" });
    return e;
  }

  const api = { extract };
  if (isNode) module.exports = api;
  else root.DocExtract = api;
})(typeof window !== "undefined" ? window : globalThis);
