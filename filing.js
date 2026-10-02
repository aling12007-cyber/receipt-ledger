// Receipt Ledger — year-end filing calculations for Japanese sole proprietors.
// Pure functions (no DOM): 損益計算書, 減価償却, 貸借対照表. Exposes window.Filing (and module.exports for tests).
(function (root) {
  // ---------- 減価償却 (straight-line, 平成19年4月1日以後取得) ----------
  const SL_RATE = { 2: .5, 3: .334, 4: .25, 5: .2, 6: .167, 7: .143, 8: .125, 9: .112, 10: .1, 11: .091, 12: .084, 13: .077, 14: .072, 15: .067,
    16: .063, 17: .059, 18: .056, 19: .053, 20: .05, 21: .048, 22: .046, 23: .044, 24: .042, 25: .04, 26: .039, 27: .038, 28: .036, 29: .035, 30: .034,
    31: .033, 32: .032, 33: .031, 34: .03, 35: .029, 36: .028, 37: .028, 38: .027, 39: .026, 40: .025, 41: .025, 42: .024, 43: .024, 44: .023, 45: .023,
    46: .022, 47: .022, 48: .021, 49: .021, 50: .02 };
  const slRate = (life) => SL_RATE[Math.max(2, Math.min(50, Math.round(+life || 0)))] || 0;

  // Common 耐用年数 presets (国税庁 別表第一). cat = 貸借対照表 line.
  const PRESETS = [
    { key: "pc", ja: "パソコン（サーバー以外）", life: 4, cat: "工具器具備品" },
    { key: "software", ja: "ソフトウェア（自社利用）", life: 5, cat: "工具器具備品" },
    { key: "camera", ja: "カメラ", life: 5, cat: "工具器具備品" },
    { key: "copier", ja: "複合機・コピー機", life: 5, cat: "工具器具備品" },
    { key: "desk_metal", ja: "事務机・椅子（金属製）", life: 15, cat: "工具器具備品" },
    { key: "desk_other", ja: "事務机・椅子（その他）", life: 8, cat: "工具器具備品" },
    { key: "car", ja: "普通自動車", life: 6, cat: "車両運搬具" },
    { key: "kei", ja: "軽自動車", life: 4, cat: "車両運搬具" },
    { key: "other", ja: "その他", life: 0, cat: "工具器具備品" },
  ];

  // 少額減価償却資産の特例 (青色申告のみ): <30万円, or <40万円 if acquired 2026-04-01〜2029-03-31. Annual cap 300万円.
  function smallLimit(date) {
    const d = String(date || "");
    return d >= "2026-04" && d < "2029-04" ? 400000 : 300000;
  }

  function parseYM(date) {
    const m = String(date || "").match(/^(\d{4})-(\d{1,2})/);
    return m ? { y: +m[1], m: +m[2] } : null;
  }

  // One asset in one year → { open, dep, close, months, rate } or null if not yet acquired / fully written off before.
  function assetYear(a, year) {
    const ym = parseYM(a.date), cost = Math.max(0, Math.round(+a.cost || 0));
    if (!ym || !cost || year < ym.y) return null;
    let book = cost, out = null;
    for (let y = ym.y; y <= year; y++) {
      const open = y === ym.y ? cost : book;
      let dep = 0, months = 12, rate = 0;
      if (a.method === "small") {
        dep = y === ym.y ? cost : 0; months = y === ym.y ? 13 - ym.m : 0;
      } else if (a.method === "lump3") {
        const third = Math.floor(cost / 3);
        dep = y < ym.y + 2 ? third : y === ym.y + 2 ? cost - third * 2 : 0;
        months = dep ? 12 : 0;
      } else {
        rate = slRate(a.life);
        months = y === ym.y ? 13 - ym.m : 12;
        dep = Math.floor(cost * rate * months / 12);
        dep = Math.max(0, Math.min(dep, book - 1)); // keep ¥1 備忘価額
      }
      book = open - dep;
      out = { open, dep, close: book, months, rate, acquiredThisYear: y === ym.y };
    }
    return out;
  }

  function depreciation(assets, year) {
    const rows = [];
    let dep = 0, biz = 0, priv = 0, open = 0, close = 0, smallTotal = 0;
    for (const a of assets || []) {
      const r = assetYear(a, year);
      if (!r) continue;
      const ratio = Math.min(100, Math.max(0, a.ratio === "" || a.ratio == null ? 100 : +a.ratio));
      const b = Math.floor(r.dep * ratio / 100);
      rows.push({ ...a, ...r, ratio, business: b, private: r.dep - b });
      dep += r.dep; biz += b; priv += r.dep - b;
      open += r.acquiredThisYear ? 0 : r.open; close += r.close;
      if (a.method === "small" && r.acquiredThisYear) smallTotal += Math.round(+a.cost || 0);
    }
    return { rows, dep, business: biz, private: priv, open, close, smallTotal, smallOver: smallTotal > 3000000 };
  }

  // ---------- 損益計算書 ----------
  // Expense rows of the 青色申告決算書（一般用）, ⑧〜㉔, then six blank rows ㉕〜㉚ for other accounts, ㉛ 雑費.
  const STD = ["租税公課", "荷造運賃", "水道光熱費", "旅費交通費", "通信費", "広告宣伝費", "接待交際費", "損害保険料", "修繕費", "消耗品費",
    "減価償却費", "福利厚生費", "給料賃金", "外注工賃", "利子割引料", "地代家賃", "貸倒金"];
  const circ = (n) => n <= 20 ? String.fromCharCode(0x245f + n) : n <= 35 ? String.fromCharCode(0x3250 + n - 20) : String.fromCharCode(0x32b1 + n - 36);

  // ctx: { entries, year, totalOf, bizOf, invOpen, invClose, depBusiness, deduction }
  function profitLoss(ctx) {
    const ys = ctx.entries.filter((e) => String(e.date || "").startsWith(String(ctx.year)));
    const sales = ys.filter((e) => e.type === "income").reduce((s, e) => s + ctx.totalOf(e), 0);
    const by = {};
    for (const e of ys) if (e.type !== "income") by[e.debit] = (by[e.debit] || 0) + ctx.bizOf(e);
    const purchases = by["仕入高"] || 0; delete by["仕入高"];
    by["減価償却費"] = (by["減価償却費"] || 0) + (ctx.depBusiness || 0);
    const invOpen = +ctx.invOpen || 0, invClose = +ctx.invClose || 0;
    const sub = invOpen + purchases, cogs = sub - invClose, gross = sales - cogs;
    const rows = [
      { no: circ(1), name: "売上（収入）金額（雑収入を含む）", v: sales },
      { no: circ(2), name: "期首商品（製品）棚卸高", v: invOpen },
      { no: circ(3), name: "仕入金額（製品製造原価）", v: purchases },
      { no: circ(4), name: "小計（②＋③）", v: sub },
      { no: circ(5), name: "期末商品（製品）棚卸高", v: invClose },
      { no: circ(6), name: "差引原価（④－⑤）", v: cogs },
      { no: circ(7), name: "差引金額（①－⑥）", v: gross },
    ];
    let n = 8, total = 0;
    for (const a of STD) { const v = by[a] || 0; rows.push({ no: circ(n++), name: a, v, exp: true }); total += v; }
    // other accounts (会議費, 新聞図書費 …) go into the blank rows, biggest first; overflow joins 雑費
    const extras = Object.keys(by).filter((a) => !STD.includes(a) && a !== "雑費" && by[a]).sort((a, b) => by[b] - by[a]);
    let misc = by["雑費"] || 0;
    const merged = [];
    for (let i = 0; i < 6; i++) {
      const a = extras[i];
      rows.push({ no: circ(n++), name: a || "", v: a ? by[a] : 0, exp: true, blank: true });
      if (a) total += by[a];
    }
    for (const a of extras.slice(6)) { misc += by[a]; merged.push(a); }
    rows.push({ no: circ(n++), name: "雑費", v: misc, exp: true, merged }); total += misc;
    rows.push({ no: circ(32), name: "計", v: total, sum: true });
    const net = gross - total;
    rows.push({ no: circ(33), name: "差引金額（⑦－㉜）", v: net, sum: true });
    const pre = net; // 各種引当金・準備金, 専従者給与 are not used here
    const ded = Math.min(+ctx.deduction || 0, Math.max(0, pre));
    rows.push({ no: circ(43), name: "青色申告特別控除前の所得金額", v: pre, sum: true });
    rows.push({ no: circ(44), name: "青色申告特別控除額", v: ded });
    rows.push({ no: circ(45), name: "所得金額", v: pre - ded, sum: true });
    return { rows, sales, purchases, expenses: total, income: pre, deduction: ded, taxable: pre - ded, merged };
  }

  function monthly(ctx) {
    const ys = ctx.entries.filter((e) => String(e.date || "").startsWith(String(ctx.year)));
    const out = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, sales: 0, purchases: 0 }));
    for (const e of ys) {
      const m = +String(e.date).slice(5, 7) - 1; if (m < 0 || m > 11) continue;
      if (e.type === "income") out[m].sales += ctx.totalOf(e);
      else if (e.debit === "仕入高") out[m].purchases += ctx.bizOf(e);
    }
    return out;
  }

  // 地代家賃の内訳: by payee
  function rentDetail(ctx) {
    const map = {};
    for (const e of ctx.entries) {
      if (!String(e.date || "").startsWith(String(ctx.year)) || e.type === "income" || e.debit !== "地代家賃") continue;
      const k = (e.vendor || "").trim() || "（支払先未入力）";
      const o = map[k] || (map[k] = { payee: k, total: 0, business: 0, n: 0 });
      o.total += ctx.totalOf(e); o.business += ctx.bizOf(e); o.n++;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }

  // ---------- 貸借対照表 ----------
  // Tracks the balance-sheet accounts the app uses. Unrecorded movements in cash / bank are treated the
  // usual way for sole proprietors: a shortfall is 事業主貸 (money taken for living costs), a surplus 事業主借.
  const ASSET = ["現金", "普通預金", "売掛金"], LIAB = ["未払金"];
  const num = (v) => (v === "" || v == null || isNaN(+v) ? null : Math.round(+v));

  // ctx: { entries, year, linesOf, open:{cash,bank,ar,inv,prepaid,ap,loan,advance,deposit}, close:{cash,bank,ar,inv,ap}, dep (from depreciation), assets, income }
  function balanceSheet(ctx) {
    const o = ctx.open || {}, c = ctx.close || {};
    const bal = { 現金: num(o.cash) || 0, 普通預金: num(o.bank) || 0, 売掛金: num(o.ar) || 0, 未払金: num(o.ap) || 0 };
    let kashi = 0, kari = 0;
    const apply = (acc, amt, side) => {
      if (acc === "事業主貸") { kashi += side === "dr" ? amt : -amt; return; }
      if (acc === "事業主借") { kari += side === "cr" ? amt : -amt; return; }
      if (ASSET.includes(acc)) bal[acc] += side === "dr" ? amt : -amt;
      else if (LIAB.includes(acc)) bal[acc] += side === "cr" ? amt : -amt;
    };
    for (const e of ctx.entries) {
      if (!String(e.date || "").startsWith(String(ctx.year))) continue;
      for (const l of ctx.linesOf(e)) { apply(l.dr, l.amt, "dr"); apply(l.cr, l.amt, "cr"); }
    }
    // fixed assets bought this year: dr asset / cr how it was paid
    for (const r of ctx.dep.rows) if (r.acquiredThisYear) apply(r.paidFrom || "事業主借", Math.round(+r.cost || 0), "cr");
    // private share of depreciation → 事業主貸
    kashi += ctx.dep.private;

    const adj = { collected: 0, paid: 0, bank: 0, cash: 0 };
    const ar = num(c.ar), ap = num(c.ap), bank = num(c.bank), cash = num(c.cash);
    if (ar != null) { adj.collected = bal["売掛金"] - ar; bal["普通預金"] += adj.collected; bal["売掛金"] = ar; }
    if (ap != null) { adj.paid = bal["未払金"] - ap; bal["普通預金"] -= adj.paid; bal["未払金"] = ap; }
    if (bank != null) { adj.bank = bank - bal["普通預金"]; if (adj.bank < 0) kashi += -adj.bank; else kari += adj.bank; bal["普通預金"] = bank; }
    if (cash != null) { adj.cash = cash - bal["現金"]; if (adj.cash < 0) kashi += -adj.cash; else kari += adj.cash; bal["現金"] = cash; }

    // fixed assets by 貸借対照表 line
    const fixedOpen = {}, fixedClose = {};
    for (const r of ctx.dep.rows) {
      const k = r.cat || "工具器具備品";
      fixedOpen[k] = (fixedOpen[k] || 0) + (r.acquiredThisYear ? 0 : r.open);
      fixedClose[k] = (fixedClose[k] || 0) + r.close;
    }
    const inv0 = num(o.inv) || 0, inv1 = num(c.inv) ?? inv0;
    const A = (cashV, bankV, arV, invV, fixed, ks) => {
      const rows = [["現金", cashV], ["その他の預金（普通預金）", bankV], ["売掛金", arV], ["棚卸資産", invV], ["前払金", num(o.prepaid) || 0]];
      for (const k of ["建物附属設備", "機械装置", "車両運搬具", "工具器具備品"]) rows.push([k, fixed[k] || 0]);
      rows.push(["事業主貸", ks]);
      return rows;
    };
    const L = (apV) => [["借入金", num(o.loan) || 0], ["未払金", apV], ["前受金", num(o.advance) || 0], ["預り金", num(o.deposit) || 0]];
    const assetsOpen = A(num(o.cash) || 0, num(o.bank) || 0, num(o.ar) || 0, inv0, fixedOpen, 0);
    const assetsClose = A(bal["現金"], bal["普通預金"], bal["売掛金"], inv1, fixedClose, kashi);
    const liabOpen = L(num(o.ap) || 0), liabClose = L(bal["未払金"]);
    const sum = (rows) => rows.reduce((s, r) => s + r[1], 0);
    const motoire = sum(assetsOpen) - sum(liabOpen);
    const capOpen = [["事業主借", 0], ["元入金", motoire], ["青色申告特別控除前の所得金額", 0]];
    const capClose = [["事業主借", kari], ["元入金", motoire], ["青色申告特別控除前の所得金額", ctx.income]];
    const tA0 = sum(assetsOpen), tA1 = sum(assetsClose), tL0 = sum(liabOpen) + sum(capOpen), tL1 = sum(liabClose) + sum(capClose);
    return {
      assetsOpen, assetsClose, liabOpen, liabClose, capOpen, capClose, kashi, kari, motoire, adj,
      totals: { assetsOpen: tA0, assetsClose: tA1, liabOpen: tL0, liabClose: tL1 },
      diff: tA1 - tL1,
      closeEntered: bank != null || cash != null,
    };
  }

  // 消耗品費 etc. ≥ ¥100,000 → probably a fixed asset
  function bigItems(entries, year) {
    return entries.filter((e) => String(e.date || "").startsWith(String(year)) && e.type !== "income" &&
      ["消耗品費", "雑費", "修繕費"].includes(e.debit) && (+e.amt10 || 0) + (+e.amt8 || 0) + (+e.amt0 || 0) >= 100000);
  }

  const api = { slRate, assetYear, depreciation, profitLoss, monthly, rentDetail, balanceSheet, bigItems, smallLimit, PRESETS, circ };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Filing = api;
})(typeof window !== "undefined" ? window : globalThis);
