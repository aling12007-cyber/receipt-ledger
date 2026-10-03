// Receipt Ledger — 申告前チェック: everything that would make the return wrong or hard to defend, in one list.
// Each finding: { code, level: "error"|"warn"|"info", n, tab, ids } — error: fix before filing; warn: probably wrong;
// info: worth a look. Pure: the page passes in the records and what it already knows (balance sheet, books check…).
// Exposes window.PreCheck (and module.exports for tests).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  /* eslint-disable no-undef */
  const Mer = isNode ? require("../document-intelligence/merchant.js") : root.DocMerchant;
  /* eslint-enable no-undef */
  const MIXED = ["地代家賃", "水道光熱費", "通信費"];   // usually partly private when working from home

  /**
   * @param {{ entries: any[], year: number, today: string, totalOf: (e: any) => number,
   *   needBS?: boolean, bs?: { closeEntered: boolean, diff: number } | null, booksOk?: boolean | null, booksAvailable?: boolean,
   *   deductionsEntered?: boolean, bigItems?: any[], ctax?: string, bestCtax?: string | null, homeOffice?: boolean }} c
   */
  function run(c) {
    const ys = c.entries.filter((e) => String(e.date || "").startsWith(String(c.year)));
    const exp = ys.filter((e) => e.type !== "income");
    const out = [];
    const add = (code, level, list, tab) => { const ids = Array.isArray(list) ? list.map((e) => e.id) : []; const n = Array.isArray(list) ? list.length : +list || 1; if (n) out.push({ code, level, n, tab, ids }); };

    add("future", "error", ys.filter((e) => e.date > c.today), "journal");
    if (c.needBS && c.bs) {
      if (!c.bs.closeEntered) add("bsClose", "error", 1, "filing");
      else if (c.bs.diff !== 0) add("bsDiff", "error", 1, "filing");
    }
    if (!ys.some((e) => e.type === "income")) add("noSales", "warn", 1, "entry");
    add("bigItems", "warn", c.bigItems || [], "filing");
    add("noVendor", "warn", exp.filter((e) => !String(e.vendor || "").trim()), "journal");
    add("ratioZero", "warn", exp.filter((e) => +e.bizRatio === 0), "journal");
    // same day, same amount, same shop → probably booked twice
    const seen = new Map(), dups = [];
    for (const e of exp) {
      const k = `${e.date}|${c.totalOf(e)}|${Mer.normalize(e.vendor || "").normalized}`;
      if (!String(e.vendor || "").trim()) continue;
      if (seen.has(k)) { dups.push(e); if (!dups.includes(seen.get(k))) dups.push(seen.get(k)); } else seen.set(k, e);
    }
    add("duplicates", "warn", dups, "journal");
    if (c.booksAvailable && c.booksOk === false) add("books", "warn", 1, "settings");
    if (!c.deductionsEntered) add("deductions", "warn", 1, "return");
    add("noReceipt", "info", exp.filter((e) => !e.assetId && !String(e.id).startsWith("rec-") && !String(e.id).startsWith("inv-")), "journal");
    add("mealNote", "info", exp.filter((e) => /会議費|接待交際費/.test(e.debit) && !String(e.memo || "").trim() && !/(打合|打ち合|会食|商談|ミーティング)/.test(String(e.items || ""))), "journal");
    if (c.homeOffice !== false) add("fullBiz", "info", exp.filter((e) => MIXED.includes(e.debit) && (e.bizRatio ?? 100) === 100), "journal");
    if (c.bestCtax && c.ctax && c.ctax !== "exempt" && c.ctax !== c.bestCtax) add("ctaxMethod", "info", 1, "ctax");
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  const api = { run };
  if (isNode) module.exports = api;
  else root.PreCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
