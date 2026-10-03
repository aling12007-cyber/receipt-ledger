// Receipt Ledger — bank / credit-card statement CSV import.
//   decode(): UTF-8 or Shift_JIS (most Japanese banks) · parseCSV(): quoted fields · detect(): finds the header row and
//   the date / description / withdrawal / deposit columns from common Japanese and English headers · toTransactions()
//   · match(): pairs statement lines with records already in the books (same amount, date within ±3 days) so the
//   same purchase is not booked twice · suggest(): an account for each new line (bank keywords, then the user's
//   history, then the receipt rules) — a suggestion the user confirms, never booked silently.
// Exposes window.BankImport (and module.exports for tests).
(function (root) {
  const H = {
    date: /^(日付|取引日|お取引日|利用日|ご利用日|ご利用年月日|利用年月日|年月日|取扱日|約定日|date|transaction date)$/i,
    desc: /^(摘要|内容|お取引内容|取引内容|お取扱内容|利用店名|ご利用店名|ご利用先|利用先|ご利用店名・商品名|利用店名・商品名|店名|お預り・お引出し内容|備考|メモ|description|details|merchant)$/i,
    out: /^(お支払金額|お支払い金額|支払金額|出金|出金金額|お引出し|お引出し金額|お引出金額|引出|引出金額|引出額|ご利用金額|利用金額|ご請求金額|請求金額|支払額|withdrawal|debit|amount out)$/i,
    in: /^(お預り金額|お預かり金額|預り金額|お預入れ|お預入れ金額|預入|預入金額|入金|入金金額|入金額|deposit|credit|amount in)$/i,
    amount: /^(金額|取引金額|amount)$/i,
    balance: /^(残高|差引残高|お取引後残高|balance)$/i,
  };
  const Z2H = (s) => String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ．，－／：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
  const norm = (s) => Z2H(s).replace(/[\s"']/g, "").replace(/[（(].*?[)）]$/, "");

  /** UTF-8, falling back to Shift_JIS. @param {Uint8Array|ArrayBuffer} bytes */
  function decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, ""); } catch (e) { /* not UTF-8 */ }
    try { return new TextDecoder("shift_jis").decode(u8); } catch (e) { return new TextDecoder("utf-8").decode(u8); }
  }

  /** RFC 4180-ish: quotes, "" escapes, CRLF, commas or tabs. @param {string} text @returns {string[][]} */
  function parseCSV(text) {
    const s = String(text || "").replace(/^﻿/, "");
    const firstLine = s.split(/\r?\n/, 1)[0] || "";
    const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
    const rows = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"') q = true;
      else if (c === sep) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
  }

  /** @param {string} v @returns {string|null} YYYY-MM-DD */
  function parseDate(v) {
    const s = Z2H(v).trim();
    let m = s.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/^(R|令和|H|平成)\s*(\d{1,2}|元)[/.\-年](\d{1,2})[/.\-月](\d{1,2})/i);
    if (m) { const n = m[2] === "元" ? 1 : +m[2]; return iso((/^(R|令和)$/i.test(m[1]) ? 2018 : 1988) + n, +m[3], +m[4]); }
    m = s.match(/^(\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
    if (m) return iso(2000 + +m[1], +m[2], +m[3]);
    return null;
  }
  function iso(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  /** "¥1,234" "△500" "(500)" "-500円" → number (NaN when empty). @param {string} v */
  function parseAmount(v) {
    let s = Z2H(v).trim();
    if (!s) return NaN;
    let neg = false;
    if (/^[△▲-]/.test(s) || /^\(.*\)$/.test(s)) { neg = true; s = s.replace(/^[△▲-]|[()]/g, ""); }
    s = s.replace(/[¥￥,円\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return (neg ? -1 : 1) * Math.round(+s);
  }

  /**
   * Finds the header row and columns.
   * @param {string[][]} rows
   * @returns {{ ok: boolean, header: number, date: number, desc: number, out: number, in: number, amount: number, signed: boolean }}
   */
  function detect(rows) {
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const h = rows[r].map(norm), find = (re) => h.findIndex((x) => re.test(x));
      const c = { date: find(H.date), desc: find(H.desc), out: find(H.out), in: find(H.in), amount: find(H.amount) };
      if (c.date >= 0 && (c.out >= 0 || c.in >= 0 || c.amount >= 0)) {
        if (c.desc < 0) c.desc = h.findIndex((x, i) => i !== c.date && i !== c.out && i !== c.in && i !== c.amount && !H.balance.test(x) && x);
        return { ok: true, header: r, ...c, signed: c.out < 0 && c.in < 0 };
      }
    }
    // no header: date in col 0 and a number somewhere (some card CSVs)
    const first = rows.findIndex((r) => parseDate(r[0] || ""));
    if (first >= 0) {
      const r = rows[first], amt = r.findIndex((x, i) => i > 0 && !Number.isNaN(parseAmount(x)) && /\d/.test(x));
      if (amt > 0) return { ok: true, header: first - 1, date: 0, desc: amt > 1 ? 1 : -1, out: amt, in: -1, amount: -1, signed: false };
    }
    return { ok: false, header: -1, date: -1, desc: -1, out: -1, in: -1, amount: -1, signed: false };
  }

  /**
   * @param {string[][]} rows @param {ReturnType<typeof detect>} c
   * @param {"bank"|"card"} kind card statements list spending as positive amounts
   * @returns {Array<{ line: number, date: string, desc: string, out: number, in: number }>}
   */
  function toTransactions(rows, c, kind) {
    const out = [];
    for (let i = c.header + 1; i < rows.length; i++) {
      const r = rows[i], date = parseDate(r[c.date] || "");
      if (!date) continue;
      const desc = c.desc >= 0 ? Z2H(r[c.desc] || "").trim().replace(/\s+/g, " ") : "";
      let o = c.out >= 0 ? parseAmount(r[c.out] || "") : NaN, n = c.in >= 0 ? parseAmount(r[c.in] || "") : NaN;
      if (c.amount >= 0 && Number.isNaN(o) && Number.isNaN(n)) {
        const a = parseAmount(r[c.amount] || "");
        if (!Number.isNaN(a)) { if (kind === "card") { if (a >= 0) o = a; else n = -a; } else if (a < 0) o = -a; else n = a; }
      }
      if (!Number.isNaN(o) && o < 0) { n = (Number.isNaN(n) ? 0 : n) - o; o = NaN; }   // a negative charge is a refund
      const ov = Number.isNaN(o) ? 0 : o, iv = Number.isNaN(n) ? 0 : n;
      if (!ov && !iv) continue;
      out.push({ line: i + 1, date, desc, out: ov, in: iv });
    }
    return out;
  }

  const dayDiff = (a, b) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000;

  /** Stable id for a statement line, so importing the same file twice finds what was already booked. */
  function txId(t) {
    const s = `${t.date}|${t.desc}|${t.out}|${t.in}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return "bank-" + t.date.replace(/-/g, "") + "-" + h.toString(36);
  }

  /**
   * Pairs statement lines with existing records: an earlier import of the same line (by id), or a record with the
   * same amount and kind within ±days (closest date first; each record pairs at most once).
   * @param {ReturnType<typeof toTransactions>} txs @param {any[]} entries @param {{ totalOf: (e: any) => number, days?: number, invoices?: any[] }} o
   */
  function match(txs, entries, o) {
    const days = o.days ?? 3, used = new Set(), ids = new Set(entries.map((e) => e.id));
    const res = txs.map((t) => ({ tx: t, id: txId(t), status: "new", entry: null, invoice: null }));
    for (const r of res) if (ids.has(r.id)) { r.status = "imported"; used.add(r.id); }
    // tightest pairs first
    const cands = [];
    for (const r of res) {
      if (r.status !== "new") continue;
      const amt = r.tx.out || r.tx.in, type = r.tx.out ? "expense" : "income";
      for (const e of entries) {
        if (e.type !== type || used.has(e.id) || String(e.id).startsWith("bank-")) continue;
        if (o.totalOf(e) !== amt) continue;
        const d = dayDiff(e.date, r.tx.date);
        if (d <= days) cands.push({ r, e, d });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands) if (c.r.status === "new" && !used.has(c.e.id)) { c.r.status = "matched"; c.r.entry = c.e; used.add(c.e.id); }
    // deposits that pay an open invoice (amount = invoice total, or total minus a bank fee up to ¥880)
    for (const r of res) {
      if (r.status !== "new" || !r.tx.in) continue;
      const inv = (o.invoices || []).find((v) => v.status !== "paid" && v.total >= r.tx.in && v.total - r.tx.in <= 880 && r.tx.date >= v.issueDate && !res.some((x) => x.invoice === v));
      if (inv) { r.status = "invoice"; r.invoice = inv; }
    }
    return res;
  }

  /** @type {Array<[RegExp, string]>} */
  const BANK_RULES = [
    [/(振込手数料|振替手数料|手数料|TESURYO)/i, "支払手数料"],
    [/(NTT|ドコモ|DOCOMO|ソフトバンク|SOFTBANK|KDDI|AU\b|楽天モバイル|UQ|ワイモバイル|Y!MOBILE|プロバイダ|ビッグローブ|BIGLOBE|OCN|NURO|さくらインターネット|エックスサーバー|XSERVER|お名前|ONAMAE|GOOGLE\s*\*?WORKSPACE|GSUITE)/i, "通信費"],
    [/(電力|でんき|電気|東京ガス|大阪ガス|ガス|水道|TEPCO|KANDEN)/i, "水道光熱費"],
    [/(JR|ＪＲ|SUICA|PASMO|ICOCA|モバイルSUICA|タクシー|TAXI|GO\b|S\.RIDE|ANA|JAL|PEACH|新幹線|EX予約|ETC|高速|NEXCO|駐車|パーキング|TIMES|タイムズ)/i, "旅費交通費"],
    [/(家賃|賃料|ヤチン|レント)/i, "地代家賃"],
    [/(ADOBE|アドビ|MICROSOFT|マイクロソフト|ZOOM|SLACK|NOTION|GITHUB|DROPBOX|CANVA|CHATGPT|OPENAI|ANTHROPIC|CLAUDE|FIGMA|AWS|AMAZON WEB SERVICES|VERCEL|SUPABASE|APPLE\.COM\/BILL|ICLOUD)/i, "通信費"],
    [/(ヤマト|佐川|日本郵便|ゆうパック|郵便局|クロネコ)/i, "荷造運賃"],
  ];
  // personal money moving (taxes on the owner, cash withdrawals, card bills): not an expense — left out by default
  const PERSONAL = /(国民年金|国民健康保険|住民税|所得税|事業税|市県民税|固定資産税|ATM|引出|カード引落|ｶｰﾄﾞ|振替)/i;
  /**
   * @param {{ desc: string, out: number, in: number }} t
   * @param {{ knowledge?: (desc: string) => string|null, guess?: (desc: string) => string }} [o]
   * @returns {{ account: string, source: "bank"|"history"|"rules"|"income"|"personal" }}
   */
  function suggest(t, o) {
    const d = Z2H(t.desc || "");
    if (PERSONAL.test(d) && !/手数料/.test(d)) return { account: t.in ? "事業主借" : "事業主貸", source: "personal" };
    if (t.in) return { account: /(利息|リソク)/.test(d) ? "事業主借" : "売上高", source: "income" };
    for (const [re, a] of BANK_RULES) if (re.test(d)) return { account: a, source: "bank" };
    const h = o && o.knowledge ? o.knowledge(d) : null;
    if (h) return { account: h, source: "history" };
    return { account: (o && o.guess ? o.guess(d) : null) || "雑費", source: "rules" };
  }

  /**
   * The record for a new statement line.
   * @param {{ date: string, desc: string, out: number, in: number }} t @param {string} account debit (expense) or 売上高 (income)
   * @param {string} via the statement's account: 普通預金 (bank), 未払金 (business card), 事業主借 (personal card)
   */
  function toEntry(t, account, via) {
    const inc = !!t.in, amt = inc ? t.in : t.out;
    return { id: txId(t), type: inc ? "income" : "expense", date: t.date, vendor: t.desc.slice(0, 60), items: t.desc.slice(0, 80), invoiceNo: "",
      amt10: amt, amt8: 0, amt0: 0, debit: inc ? via : account, credit: inc ? "売上高" : via, bizRatio: 100, memo: "明細CSV" };
  }

  const api = { decode, parseCSV, parseDate, parseAmount, detect, toTransactions, match, suggest, toEntry, txId };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BankImport = api;
})(typeof window !== "undefined" ? window : globalThis);
