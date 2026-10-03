// Receipt Ledger — Document Intelligence: numbers, dates and registration numbers read by OCR.
// OCR confuses 0/O/D, 1/I/l/|, 5/S, 8/B, 2/Z, ¥/Y/羊/半, and the thousands separator with a period.
// Every correction is recorded, so a value that needed fixing never looks as certain as one read cleanly.
// Exposes window.DocDigits (and module.exports for tests).
(function (root) {
  const FULLWIDTH = /[０-９Ａ-Ｚａ-ｚ]/g;
  const toHalf = (s) => String(s).replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，､、](?=\d)/g, ",").replace(/[．](?=\d)/g, ".").replace(/[￥]/g, "¥").replace(/[：]/g, ":").replace(/[％]/g, "%");
  // letters that are digits when they sit inside a number
  const LOOKALIKE = { O: "0", o: "0", D: "0", Q: "0", I: "1", l: "1", "|": "1", "!": "1", S: "5", s: "5", B: "8", Z: "2", z: "2", G: "6", b: "6", g: "9", q: "9" };
  // digits that OCR swaps with each other: a value containing them is less certain
  const SWAPPABLE = /[0683157]/;

  /**
   * One amount token → integer yen. "¥1,100" "1.100" "11,8OO" "Y1100" "1100円" "△100" (negative)
   * @param {string} token
   * @returns {{ value: number|null, corrected: string[], ambiguous: boolean, raw: string }}
   */
  function amount(token) {
    const raw = String(token);
    let s = toHalf(raw).trim();
    const corrected = [];
    const neg = /^[-−△▲]/.test(s);
    s = s.replace(/^[-−△▲]\s*/, "");
    if (/^[Y羊半\\]\s*\d/.test(s)) { corrected.push("yen-sign"); s = s.replace(/^[Y羊半\\]/, "¥"); }
    s = s.replace(/^¥\s*/, "").replace(/\s*(円|-)$/, "");
    // letters inside the digits
    for (let k = 0, prev = ""; k < 6 && prev !== s; k++) {
      prev = s;
      s = s.replace(/(?<=[\d,.])[ODQoIl|!SsBZzGbgq]|[ODQoIl|!SsBZzGbgq](?=[\d,.])/g, (c) => { corrected.push(c + "→" + LOOKALIKE[c]); return LOOKALIKE[c]; });
    }
    s = s.replace(/\s+/g, "");
    // yen has no decimals: 1.100 / 11.800 is a misread thousands separator
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) { corrected.push("period→comma"); s = s.replace(/\./g, ","); }
    if (/^\d{1,3}(,\d{3})*$|^\d+$/.test(s)) {
      const v = parseInt(s.replace(/,/g, ""), 10);
      return { value: neg ? -v : v, corrected, ambiguous: corrected.length > 0, raw };
    }
    // a comma in the wrong place ("1,10" / "11,80O") cannot be trusted
    if (/^[\d,]+$/.test(s)) return { value: parseInt(s.replace(/,/g, ""), 10) * (neg ? -1 : 1), corrected: [...corrected, "comma-position"], ambiguous: true, raw };
    return { value: null, corrected, ambiguous: true, raw };
  }

  /** Every amount on a line, left to right, with its position. @param {string} line */
  function amountsIn(line) {
    const out = [];
    // a number may end in a lookalike ("11,8OO"); it must contain at least one real digit (checked below)
    const re = /(?:[-−△▲]\s*)?(?:[¥Y羊半\\]\s*)?[\dODQoIl|SBZ][\dODQoIl|SBZ,.\s]*[\dOoDQ](?:\s*円)?|(?:[¥Y]\s*)\d/g;
    let m;
    const s = toHalf(line);
    while ((m = re.exec(s))) {
      const tok = m[0].trim();
      // a percentage or a time is not an amount
      if (/%/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 1)) || /^\d{1,2}:\d{2}/.test(s.slice(m.index)) || /:\s*$/.test(s.slice(0, m.index))) continue;
      const a = amount(tok);
      if (a.value != null && /\d/.test(tok) && (a.value !== 0 || /0/.test(tok))) out.push({ ...a, index: m.index });
    }
    return out;
  }

  /** Does a value contain digits OCR often swaps (0/6/8, 3/8, 1/7, 5/6)? @param {number|string} v */
  const swappable = (v) => SWAPPABLE.test(String(v));

  /**
   * 法人番号 check digit (the first digit of the 13): 9 − (Σ Pn × Qn mod 9), Pn the n-th digit of the other 12 counted
   * from the right, Qn = 1 for odd n and 2 for even n. Corporations' registration numbers are T + 法人番号.
   * @param {string} d13
   */
  function corporateCheckDigitOk(d13) {
    if (!/^\d{13}$/.test(d13)) return false;
    const base = d13.slice(1);
    let sum = 0;
    for (let n = 1; n <= 12; n++) sum += Number(base[12 - n]) * (n % 2 ? 1 : 2);
    return Number(d13[0]) === 9 - (sum % 9);
  }

  /**
   * Registration number (適格請求書発行事業者登録番号) in OCR text.
   * status: "registered" (T + 13 digits read cleanly), "uncertain" (found but misread characters were fixed,
   * the digit count is off, or a corporation's check digit fails), "not_found" (no trace of one).
   * Not reading a number is never taken as proof there is none: a 登録番号 label without a readable number is "uncertain".
   * @param {string} text @param {{ corporate?: boolean }} [o]
   */
  function invoice(text, o = {}) {
    const lines = toHalf(text).split("\n");
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const labelled = /登録番号|登録No|インボイス|適格/.test(l);
      // T (or a lookalike: 丁 Τ ㇳ 7 at the start) followed by 13 digit-like characters, spaces and hyphens allowed
      // lookalikes of T (丁 7) only count on a line labelled 登録番号; elsewhere "7 + 13 digits" may be a card or phone number
      const flat = l.replace(/[\s-]/g, "");
      const m = flat.match(/(?:^|[^A-Z0-9])([TΤ])([\dODQoIl|SBZ]{12,14})(?![\d])/) || (labelled && (flat.match(/(?:^|[^A-Z0-9])([T丁Τ7])([\dODQoIl|SBZ]{12,14})(?![\d])/) || flat.match(/()([\dODQoIl|SBZ]{12,14})(?![\d])/)));
      if (!m) { if (labelled && !best) best = { value: null, status: "uncertain", line: i, corrected: ["label-without-number"] }; continue; }
      const corrected = [];
      if (m[1] && m[1] !== "T") corrected.push(m[1] + "→T");
      if (!labelled && m[1] === "T" && /\d{14}/.test(flat)) continue;   // part of a longer number
      if (!m[1]) corrected.push("missing-T");
      const digits = m[2].replace(/[ODQoIl|SBZ]/g, (c) => { corrected.push(c + "→" + LOOKALIKE[c]); return LOOKALIKE[c]; });
      if (digits.length !== 13) { best = { value: "T" + digits, status: "uncertain", line: i, corrected: [...corrected, "digits:" + digits.length] }; continue; }
      const check = corporateCheckDigitOk(digits);
      const status = corrected.length || (o.corporate && !check) ? "uncertain" : "registered";
      const cand = { value: "T" + digits, status, line: i, corrected, checkDigit: check ? "ok" : o.corporate ? "ng" : "n/a" };
      if (!best || best.status !== "registered") best = cand;
      if (status === "registered") break;
    }
    return best || { value: null, status: "not_found", line: -1, corrected: [] };
  }

  /**
   * Date in Japanese receipt formats: 2026年9月28日, 2026/09/28, 2026-9-28, 26/09/28, R8.9.28, 令和8年9月28日.
   * @param {string} text @param {number} year fiscal year (to read two-digit years)
   * @returns {{ value: string|null, line: number, corrected: string[] }}
   */
  function date(text, year) {
    const lines = toHalf(text).split("\n");
    const pad = (n) => String(n).padStart(2, "0");
    const ok = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const corrected = [];
      const l = raw.replace(/(?<=\d)[OoD](?=\d)|(?<=[年/.\-])[OoD](?=\d)/g, () => { corrected.push("O→0"); return "0"; });
      let m = l.match(/(?:令和|R\.?)\s*(\d{1,2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/);
      if (m) { const y = 2018 + Number(m[1]); if (ok(y, +m[2], +m[3])) return { value: `${y}-${pad(m[2])}-${pad(m[3])}`, line: i, corrected }; }
      m = l.match(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/);
      if (m && ok(+m[1], +m[2], +m[3])) return { value: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, line: i, corrected };
      m = l.match(/(?<!\d)(\d{2})[./](\d{1,2})[./](\d{1,2})(?!\d)/);
      if (m) { const y = 2000 + Number(m[1]); if (ok(y, +m[2], +m[3]) && Math.abs(y - year) <= 1) return { value: `${y}-${pad(m[2])}-${pad(m[3])}`, line: i, corrected: [...corrected, "two-digit-year"] }; }
    }
    return { value: null, line: -1, corrected: [] };
  }

  const api = { toHalf, amount, amountsIn, swappable, corporateCheckDigitOk, invoice, date };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocDigits = api;
})(typeof window !== "undefined" ? window : globalThis);
