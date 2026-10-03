// Receipt Ledger — Document Intelligence: evaluation on the golden documents.
// Not only OCR accuracy: Correct document → correct transaction → correct journal, plus how often a person has to look
// (review rate), how often validation stops a document, whether duplicates are found, and — the safety metric —
// how many documents would pass without review although their journal entry is wrong.
// Exposes window.DocEvaluate (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const req = (n, g) => (isNode ? require(n) : root[g]);
  /* eslint-enable no-undef */
  const mods = () => ({
    O: req("../ocr.js", "ReceiptOCR"), X: req("./extract.js", "DocExtract"), V: req("./validate.js", "DocValidate"), C: req("./confidence.js", "DocConfidence"),
    T: req("./transaction.js", "DocTransaction"), Mer: req("./merchant.js", "DocMerchant"), Dup: req("./duplicate.js", "DocDuplicate"),
    Books: req("../books.js", "Books"), Migrate: req("../engine/migrate.js", "Migrate"),
  });

  /** Read one text document the way the app does (on-device reader → extraction → validation → confidence → suggestion → entry). */
  function processText(text, o = {}) {
    const { O, X, V, C, T } = mods();
    const year = o.year || 2026, today = o.today || "2026-10-03";
    const r = O.parseReceiptText(text, { year });
    const ex = X.extract({ text, r, year, readingConfidence: o.readingConfidence ?? 0.85 });
    X.apply(r, ex);
    const validation = V.validate(ex, { year, today });
    const suggestion = T.suggestAccount({ merchant: r.vendor, text, amount: r.total, date: r.date, blue: true, knowledge: o.knowledge || [],
      rules: O.guessAccount(String(r.vendor || "") + " " + text.slice(0, 200), text) });
    if (suggestion.source === "history" && suggestion.confidence >= 0.6) r.account = suggestion.account;
    const confidence = C.score(ex, { validation, account: { account: r.account || suggestion.account, confidence: (r.account || suggestion.account) === suggestion.account ? suggestion.confidence : 0.5, source: suggestion.source } });
    const entry = { type: "expense", date: r.date, vendor: r.vendor, invoiceNo: r.invoice_no || "", amt10: +r.amount_10 || 0, amt8: +r.amount_8 || 0, amt0: +r.amount_other || 0,
      debit: r.account || suggestion.account, credit: r.payment === "cash" ? "事業主借" : "未払金", bizRatio: 100 };
    return { r, extraction: ex, validation, confidence, suggestion, entry };
  }

  const ratesOf = (ex) => (ex.taxBreakdown || []).filter((b) => b.taxableAmount != null)
    .map((b) => [b.rate, b.rate && b.inclusive === false ? b.taxableAmount + (b.taxAmount || 0) : b.taxableAmount]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const lineKey = (ls) => ls.map((l) => [l.account, +l.dr, +l.cr, l.tax_code].join("|")).sort().join(";");

  /**
   * @param {Array<any>} cases DocGolden.CASES
   * @param {{ year?: number, today?: string }} [o]
   */
  function run(cases, o = {}) {
    const { Mer, Dup, Books, Migrate, T } = mods();
    const results = [], keys = [];
    for (const c of cases) {
      const p = processText(c.text, o), e = c.expected, ex = p.extraction;
      const v = (f) => ex[f] && ex[f].value;
      /** @type {Record<string, boolean>} */
      const fields = {};
      if (e.documentType) fields.documentType = v("documentType") === e.documentType;
      if (e.date) fields.date = v("issueDate") === e.date || p.r.date === e.date;
      if (e.merchant) fields.merchant = Mer.normalize(p.r.vendor || "").normalized === e.merchant || Mer.normalize(v("merchantName") || "").normalized === e.merchant;
      if (e.subtotal != null) fields.subtotal = v("subtotal") === e.subtotal;
      if (e.tax != null) fields.tax = v("taxTotal") === e.tax;
      if (e.total != null) fields.total = v("total") === e.total;
      if (e.rates) fields.taxRate = same(ratesOf(ex), e.rates.slice().sort((a, b) => b[0] - a[0] || b[1] - a[1]));
      if (e.invoice) fields.invoice = (v("invoiceRegistrationNumber") || null) === e.invoice.value && v("invoiceStatus") === e.invoice.status;
      if (e.payment) fields.payment = (v("paymentMethod") || "unknown") === e.payment;
      if (e.account) fields.account = p.entry.debit === e.account;
      const checks = {};
      if (e.validation) checks.validation = p.validation.status === e.validation;
      if (e.review) checks.review = p.confidence.needsReview === true;
      if (e.corrected) checks.corrected = !!(ex[e.corrected] && ex[e.corrected].corrected && ex[e.corrected].corrected.length) && fields.total !== false;
      if (e.fixedAsset != null) checks.fixedAsset = !!p.suggestion.fixedAssetCandidate === e.fixedAsset;
      // duplicates: compared with the documents read before this one
      const key = { id: c.id, date: p.r.date, total: p.r.total, merchant: p.r.vendor, receiptNumber: v("receiptNumber"), invoiceNo: p.r.invoice_no, text: c.text };
      const dup = Dup.find(key, keys);
      if (c.duplicateOf) checks.duplicate = dup.level === "likely" && dup.matches[0].id === c.duplicateOf;
      else checks.noFalseDuplicate = dup.level !== "likely";
      keys.push(key);
      // correct document → correct transaction → correct journal
      let transaction = null, journal = null;
      if (e.entry) {
        const want = { type: "expense", date: e.date || p.entry.date, amt10: e.entry.amt10, amt8: e.entry.amt8, amt0: e.entry.amt0, debit: e.entry.debit,
          credit: (e.payment || p.r.payment) === "cash" ? "事業主借" : "未払金", bizRatio: 100 };
        const got = p.entry;
        transaction = got.date === want.date && Books.totalOf(got) === Books.totalOf(want) && got.debit === want.debit && got.amt10 === want.amt10 && got.amt8 === want.amt8 && got.amt0 === want.amt0;
        const jg = T.toJournal(got, (x) => Migrate.rowLines(x, Books)), jw = T.toJournal(want, (x) => Migrate.rowLines(x, Books));
        journal = jg.balanced && lineKey(jg.lines) === lineKey(jw.lines);
      }
      const documentOk = Object.values(fields).every(Boolean);
      results.push({ id: c.id, category: c.category, title: c.title, fields, checks, documentOk, transaction, journal,
        needsReview: p.confidence.needsReview, validation: p.validation.status, duplicateScore: dup.duplicateScore,
        detail: { total: v("total"), date: v("issueDate"), account: p.entry.debit, low: p.confidence.lowFields, problems: p.validation.checks.filter((k) => k.level !== "ok").map((k) => k.code) } });
    }
    return { results, metrics: metrics(results) };
  }

  /** @param {Array<any>} results */
  function metrics(results) {
    const rate = (xs) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10 : null);
    const field = (f) => rate(results.filter((r) => f in r.fields).map((r) => r.fields[f]));
    const withEntry = results.filter((r) => r.journal != null);
    const dupCases = results.filter((r) => "duplicate" in r.checks);
    return {
      fieldAccuracy: rate(results.flatMap((r) => Object.values(r.fields))),
      dateAccuracy: field("date"), merchantAccuracy: field("merchant"), subtotalAccuracy: field("subtotal"), taxAccuracy: field("tax"),
      totalAccuracy: field("total"), taxRateAccuracy: field("taxRate"), invoiceAccuracy: field("invoice"), classificationAccuracy: field("documentType"),
      paymentAccuracy: field("payment"), accountAccuracy: field("account"),
      documentAccuracy: rate(results.map((r) => r.documentOk)),
      transactionAccuracy: rate(withEntry.map((r) => r.transaction)), journalAccuracy: rate(withEntry.map((r) => r.journal)),
      autoApprovalRate: rate(results.map((r) => !r.needsReview)), humanReviewRate: rate(results.map((r) => r.needsReview)),
      validationErrorRate: rate(results.map((r) => r.validation === "error")),
      duplicateDetectionRate: rate(dupCases.map((r) => r.checks.duplicate)),
      falseDuplicateRate: rate(results.filter((r) => "noFalseDuplicate" in r.checks).map((r) => !r.checks.noFalseDuplicate)),
      checksPassed: rate(results.flatMap((r) => Object.values(r.checks))),
      // safety: would pass without review although the journal entry is wrong
      falseAutoApprovals: withEntry.filter((r) => !r.needsReview && !r.journal).map((r) => r.id),
      cases: results.length,
    };
  }

  const api = { processText, run, metrics };
  if (isNode) module.exports = api;
  else root.DocEvaluate = api;
})(typeof window !== "undefined" ? window : globalThis);
