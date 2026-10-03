// Receipt Ledger — e-Tax 転記表: the figures to type into 確定申告書等作成コーナー, in the order its screens ask for them.
// 青色申告決算書（一般用）: 月別売上 → 損益計算書 → 減価償却費の計算 → 地代家賃の内訳 → 貸借対照表 → 青色申告特別控除.
// 収支内訳書（一般用）: the same without the balance sheet and the blue deduction. Labels stay Japanese (as on the site);
// section notes are translated. Only the figures come from the books — this module formats, it does not calculate.
// Exposes window.ETax (and module.exports for tests).
(function (root) {
  const L = (lang, ja, zh, en) => ({ ja, zh, en })[lang] || ja;

  /**
   * @param {{ blue: boolean, pl: { rows: Array<{ no: string, name: string, v: number, sum?: boolean, blank?: boolean }> },
   *   monthly: Array<{ m: number, sales: number, purchases: number }>, rent: Array<{ payee: string, total: number, business: number }>,
   *   dep: Array<any>, bs?: any, needBS?: boolean }} d
   * @param {string} lang
   * @returns {Array<{ key: string, title: string, note: string, items: Array<{ label: string, value: number|string, yen: boolean }> }>}
   */
  function sheets(d, lang) {
    const out = [];
    const Y = (label, value) => ({ label, value: Math.round(+value || 0), yen: true });
    const S = (label, value) => ({ label, value: String(value ?? ""), yen: false });

    out.push({ key: "monthly", title: L(lang, "月別売上（収入）金額及び仕入金額", "每月營收及進貨金額", "Monthly sales and purchases"),
      note: L(lang, "作成コーナーの最初の画面です。売上のない月は空欄のままで構いません。", "作成コーナー的第一個畫面。沒有營收的月份可以空著。", "The first screen. Leave months without sales empty."),
      items: d.monthly.flatMap((m) => [...(m.sales ? [Y(`${m.m}月 売上（収入）金額`, m.sales)] : []), ...(m.purchases ? [Y(`${m.m}月 仕入金額`, m.purchases)] : [])]) });

    const r = d.pl.rows;
    const top = r.filter((x) => /^[①-⑦]$/.test(x.no) && !/小計|差引/.test(x.name));
    const exp = r.filter((x) => x.name && !x.sum && !/^[①-⑦]$/.test(x.no) && !/青色申告特別控除額|所得金額/.test(x.name) && x.v);
    out.push({ key: "pl", title: L(lang, "損益計算書（収支の計算）", "損益表（收支計算）", "Profit and loss"),
      note: L(lang, "経費は金額のある科目だけ。⑳〜㉚の空欄の科目は、科目名も入力します。小計・差引は自動計算されます。", "經費只列有金額的科目。⑳〜㉚空白欄的科目，科目名稱也要輸入。小計、差額會自動計算。", "Only accounts with an amount. For the blank rows, type the account name too. Subtotals are calculated by the site."),
      items: [...top.map((x) => Y(`${x.no} ${x.name}`, x.v)), ...exp.map((x) => Y(`${x.no} ${x.name}${x.blank ? L(lang, "（科目名も入力）", "（也輸入科目名）", " (type the name)") : ""}`, x.v))] });

    if (d.dep.length) out.push({ key: "dep", title: L(lang, "減価償却費の計算", "折舊計算", "Depreciation"),
      note: L(lang, "資産ごとに1行。作成コーナーが償却費を計算するので、下の「必要経費算入額」と同じになるか確認してください。", "每項資產一列。作成コーナー會自己算折舊，請確認和下方「必要経費算入額」相同。", "One line per asset. The site calculates depreciation; check it matches the deductible amount below."),
      items: d.dep.flatMap((a) => [S(`【${a.name}】取得年月`, a.date), Y("取得価額", a.cost), S("償却方法", { sl: "定額法", lump3: "一括償却資産", small: "少額減価償却資産" }[a.method] || "定額法"),
        ...(a.method === "sl" ? [S("耐用年数", `${a.life}年`), S("償却率", Number(a.rate).toFixed(3))] : []), S("本年中の償却期間", `${a.months}/12`),
        Y("本年分の普通償却費", a.dep), S("事業専用割合", `${a.ratio}%`), Y("本年分の必要経費算入額", a.business), Y("未償却残高（期末残高）", a.close)]) });

    if (d.rent.length) out.push({ key: "rent", title: L(lang, "地代家賃の内訳", "房租明細", "Rent details"),
      note: L(lang, "支払先の住所・氏名は契約書を見て入力します。", "付款對象的地址、姓名請看租約輸入。", "Take the landlord's name and address from the contract."),
      items: d.rent.flatMap((x) => [S("支払先", x.payee), Y("本年中の賃借料", x.total), Y("うち必要経費算入額", x.business)]) });

    if (d.blue && d.needBS && d.bs) {
      const b = d.bs, rows = [];
      const both = (pairs0, pairs1) => pairs1.forEach(([k, v], i) => { rows.push(Y(`${k}（期首 1月1日）`, (pairs0[i] || [k, 0])[1])); rows.push(Y(`${k}（期末 12月31日）`, v)); });
      both(b.assetsOpen, b.assetsClose); both(b.liabOpen, b.liabClose); both(b.capOpen, b.capClose);
      out.push({ key: "bs", title: L(lang, "貸借対照表（資産負債調）", "資產負債表", "Balance sheet"),
        note: L(lang, "金額が0の行は空欄のままで構いません。左右の合計が一致することを確認してください。", "金額 0 的列可以空著。請確認左右合計一致。", "Leave zero rows empty. Check both totals agree."),
        items: rows.filter((x) => x.value) });
    }
    const ded = r.find((x) => /青色申告特別控除額/.test(x.name)), pre = r.find((x) => /青色申告特別控除前/.test(x.name)), inc = r.find((x) => x.name === "所得金額");
    out.push({ key: "result", title: L(lang, d.blue ? "青色申告特別控除・所得金額" : "所得金額", d.blue ? "青色申告特別控除・所得" : "所得", d.blue ? "Blue deduction and income" : "Income"),
      note: L(lang, "作成コーナーの表示と同じ数字になれば、決算書は完成です。65万円控除は e-Tax で送信する場合です。", "作成コーナー顯示的數字一樣的話，決算書就完成了。65 萬扣除需要用 e-Tax 送出。", "When the site shows the same figures, the statement is done. The ¥650,000 deduction needs e-Tax submission."),
      items: [pre && Y("青色申告特別控除前の所得金額", pre.v), d.blue && ded && Y("青色申告特別控除額", ded.v), inc && Y("所得金額", inc.v)].filter(Boolean) });
    return out.filter((s) => s.items.length);
  }

  /** Tab-separated text of all sheets (for pasting into a spreadsheet or a note). */
  function toText(list) {
    return list.map((s) => [`■ ${s.title}`, ...s.items.map((i) => `${i.label}\t${i.yen ? i.value : i.value}`)].join("\n")).join("\n\n");
  }

  const api = { sheets, toText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ETax = api;
})(typeof window !== "undefined" ? window : globalThis);
