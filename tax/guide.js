// Receipt Ledger — the return guide's words: what each field is (in plain language, with the document that proves it),
// and the steps on the NTA's 確定申告書等作成コーナー with the figure to type at each step. ja / zh / en.
// Exposes window.TaxGuide (and module.exports for tests).
(function (root) {
  /** Fields of the return form the user fills in. kind: yen | count | check | select */
  const FIELDS = [
    { k: "salaryIncome", group: "income", kind: "yen",
      ja: ["給与所得（給与所得控除後の金額）", "会社員などの給与もある場合。源泉徴収票の「給与所得控除後の金額」。なければ空欄。"],
      zh: ["薪資所得（扣除薪資所得扣除後的金額）", "如果也有公司薪水。看源泉徴収票上的「給与所得控除後の金額」。沒有就留空。"],
      en: ["Salary income (after the employment deduction)", "If you also have a salary: the 給与所得控除後の金額 on your 源泉徴収票. Leave empty if none."] },
    { k: "otherIncome", group: "income", kind: "yen",
      ja: ["その他の所得（雑所得など）", "副業の原稿料・年金など、事業以外の所得（収入−経費）。"],
      zh: ["其他所得（雜所得等）", "事業以外的所得（收入−費用），例如零星稿費、年金。"],
      en: ["Other income (雑所得 etc.)", "Income outside the business (receipts − costs), e.g. occasional fees, pensions."] },
    { k: "withheldFees", group: "withheld", kind: "yen",
      ja: ["報酬から源泉徴収された税額", "取引先が報酬から天引きした所得税（10.21%）の合計。支払調書や入金明細で確認。払いすぎなら還付されます。"],
      zh: ["報酬被預扣的稅額", "客戶從報酬中先扣掉的所得稅（10.21%）合計。看支払調書或入帳明細。扣太多會退稅。"],
      en: ["Tax withheld from your fees", "Income tax (10.21%) clients deducted from your fees. Check 支払調書 or payment records. Over-withholding is refunded."] },
    { k: "withheldSalary", group: "withheld", kind: "yen",
      ja: ["給与の源泉徴収税額", "源泉徴収票の「源泉徴収税額」。"], zh: ["薪資的源泉徴収税額", "源泉徴収票上的「源泉徴収税額」。"], en: ["Tax withheld from salary", "The 源泉徴収税額 on your 源泉徴収票."] },
    { k: "prepaid", group: "withheld", kind: "yen",
      ja: ["予定納税額", "7月・11月に前払いした所得税（予定納税）があれば合計。通知書で確認。"], zh: ["預定納稅額", "如果 7 月、11 月有預繳所得稅（予定納税），填合計。看通知書。"], en: ["Prepaid tax (予定納税)", "Income tax you prepaid in July and November, if any (see the notice)."] },
    { k: "socialInsurance", group: "deduction", kind: "yen",
      ja: ["社会保険料（国民年金・国民健康保険など）", "今年実際に払った国民年金・国民健康保険・介護保険。国民年金は「控除証明書」（11月頃届く）、国保は納付書・市区町村の通知で確認。家族の分を払った場合も含められます。"],
      zh: ["社會保險費（國民年金、國民健康保險等）", "今年實際繳的國民年金、國保、介護保險。國民年金看「控除証明書」（約 11 月寄到），國保看繳費單或市區町村通知。幫家人繳的也可以算。"],
      en: ["Social insurance (national pension, health insurance…)", "What you actually paid this year. Pension: the 控除証明書 (arrives around November); health insurance: payment slips or the city's notice. Family members' premiums you paid count too."] },
    { k: "smallBizMutual", group: "deduction", kind: "yen",
      ja: ["iDeCo・小規模企業共済の掛金", "全額が控除されます。証明書（掛金払込証明書）で確認。"], zh: ["iDeCo、小規模企業共済的掛金", "全額可以扣除。看掛金払込証明書。"], en: ["iDeCo / 小規模企業共済 contributions", "Fully deductible. See the contribution certificate."] },
    { k: "lifeGeneral", group: "deduction", kind: "yen",
      ja: ["生命保険料（一般）の年間支払額", "保険会社の「控除証明書」の「一般」の金額。控除額は自動で計算（最大4万円）。"], zh: ["人壽保險（一般）年繳金額", "保險公司「控除証明書」上「一般」的金額。扣除額會自動計算（最多 4 萬）。"], en: ["Life insurance (general), paid this year", "The 一般 amount on the insurer's 控除証明書. The deduction is calculated (max ¥40,000)."] },
    { k: "lifeCare", group: "deduction", kind: "yen",
      ja: ["介護医療保険料の年間支払額", "医療保険・がん保険など。控除証明書の「介護医療」の金額。"], zh: ["介護醫療保險年繳金額", "醫療險、癌症險等。看控除証明書「介護医療」的金額。"], en: ["Medical / care insurance, paid this year", "Medical or cancer insurance: the 介護医療 amount on the certificate."] },
    { k: "lifePension", group: "deduction", kind: "yen",
      ja: ["個人年金保険料の年間支払額", "控除証明書の「個人年金」の金額。"], zh: ["個人年金保險年繳金額", "看控除証明書「個人年金」的金額。"], en: ["Private pension insurance, paid this year", "The 個人年金 amount on the certificate."] },
    { k: "earthquake", group: "deduction", kind: "yen",
      ja: ["地震保険料", "火災保険のうち地震保険の部分（控除証明書）。最大5万円。"], zh: ["地震保險費", "火災保險中地震保險的部分（看控除証明書）。最多 5 萬。"], en: ["Earthquake insurance", "The earthquake part of your home insurance (certificate). Max ¥50,000."] },
    { k: "medicalPaid", group: "deduction", kind: "yen",
      ja: ["医療費の支払額（家族分も）", "病院・薬局で払った医療費の合計。10万円（所得が少なければ所得の5%）を超えた分が控除されます。領収書は5年保管。"], zh: ["醫療費支出（含家人）", "在醫院、藥局付的醫療費合計。超過 10 萬（所得低的話是所得的 5%）的部分可以扣除。收據保存 5 年。"], en: ["Medical costs paid (incl. family)", "Total paid at hospitals and pharmacies. The part above ¥100,000 (or 5% of income if lower) is deducted. Keep receipts 5 years."] },
    { k: "medicalReimbursed", group: "deduction", kind: "yen",
      ja: ["医療費の補填額", "保険金・高額療養費などで戻ってきた額。"], zh: ["醫療費補償額", "保險理賠、高額療養費等拿回來的金額。"], en: ["Medical costs reimbursed", "Insurance payouts, high-cost medical refunds, etc."] },
    { k: "donations", group: "deduction", kind: "yen",
      ja: ["ふるさと納税などの寄附金", "寄附した合計額。自治体の「寄附金受領証明書」で確認。2,000円を超える分が所得税と住民税から差し引かれます（上限あり）。"], zh: ["故鄉納稅等捐款", "捐款總額。看自治體寄來的「寄附金受領証明書」。超過 2,000 圓的部分可以從所得稅和住民稅扣除（有上限）。"], en: ["Donations (furusato nozei etc.)", "Total donated, from the 寄附金受領証明書. The part above ¥2,000 comes off income and resident tax (with a limit)."] },
    { k: "spouse", group: "deduction", kind: "check",
      ja: ["配偶者控除を受ける", "配偶者の年間の合計所得が58万円以下（給与だけなら年収123万円以下）の場合。"], zh: ["申請配偶者扣除", "配偶者全年合計所得 58 萬以下（只有薪水的話年收 123 萬以下）。"], en: ["Claim the spouse deduction", "If your spouse's total income is ¥580,000 or less (salary-only: up to ¥1.23M a year)."] },
    { k: "dependents", group: "deduction", kind: "count",
      ja: ["扶養親族（16歳以上）の人数", "生計を一にする16歳以上の家族で、所得58万円以下の人。19〜22歳は次の欄へ。"], zh: ["扶養親屬（16 歲以上）人數", "同一生計、16 歲以上、所得 58 萬以下的家人。19〜22 歲填下一欄。"], en: ["Dependants aged 16+", "Family members you support, 16 or older, income ¥580,000 or less. Ages 19–22 go in the next field."] },
    { k: "specialDependents", group: "deduction", kind: "count",
      ja: ["特定扶養親族（19〜22歳）の人数", "大学生の子どもなど。控除額63万円。"], zh: ["特定扶養親屬（19〜22 歲）人數", "例如讀大學的子女。扣除額 63 萬。"], en: ["Dependants aged 19–22", "E.g. children at university. ¥630,000 each."] },
    { k: "businessTaxRate", group: "other", kind: "select", options: ["0.05", "0.04", "0.03", "0"],
      ja: ["個人事業税の税率（業種）", "デザイン業・物品販売業・飲食店など多くの業種は5%。あんま・はり等は3%、畜産業等は4%、文筆業・画家などは対象外。"], zh: ["個人事業稅稅率（業種）", "設計業、商品販售、餐飲等多數業種是 5%。按摩、針灸等 3%，畜產業等 4%，文筆、畫家等不課。"], en: ["Business tax rate (by trade)", "Most trades (design, retail, restaurants) 5%; massage/acupuncture 3%; livestock 4%; writers and artists are not taxed."] },
  ];

  /** @param {any} f @param {string} lang */
  const text = (f, lang) => f[lang] || f.ja;

  /**
   * Steps on 確定申告書等作成コーナー (所得税) with the figures to type.
   * @param {{ sales: number, income: number, blue: number, blueKey: string }} biz 事業 (from the books)
   * @param {any} input saved answers @param {any} r IncomeTax.compute() result @param {string} lang @param {(n: number) => string} yen
   */
  function incomeSteps(biz, input, r, lang, yen) {
    const L = (ja, zh, en) => ({ ja, zh, en })[lang] || ja;
    const v = (n) => (n ? yen(n) : L("—（入力不要）", "—（不用輸入）", "— (nothing to enter)"));
    return [
      { title: L("1. 青色申告決算書を作る", "1. 先做青色申告決算書", "1. Make the 青色申告決算書"),
        body: L("作成コーナー →「作成開始」→ e-Tax（マイナンバーカード方式）→「決算書・収支内訳書」。このアプリの「決算書・申告準備」ページの1〜4ページの数字を同じ欄に入力します。",
          "作成コーナー →「作成開始」→ e-Tax（マイナンバーカード方式）→「決算書・収支内訳書」。把本 App「決算書・申告準備」頁第 1〜4 頁的數字填到相同欄位。",
          "作成コーナー → 作成開始 → e-Tax (My Number card) → 決算書・収支内訳書. Copy pages 1–4 from this app's Year-end & filing page into the same lines."),
        items: [[L("売上（収入）金額", "營業收入", "Sales"), yen(biz.sales)], [L("所得金額（青色申告特別控除前）", "所得（青色扣除前）", "Income before the blue deduction"), yen(biz.income)], [L("青色申告特別控除額", "青色申告特別扣除", "Blue-return deduction"), yen(biz.blue)]] },
      { title: L("2. 所得税の申告書：収入と所得", "2. 所得稅申告書：收入與所得", "2. Income tax return: income"),
        body: L("決算書を保存したら「所得税」へ。事業（営業等）の欄は決算書から自動で入ります。", "決算書存檔後進入「所得税」。事業（營業等）欄會從決算書自動帶入。", "Save the 決算書, then go to 所得税. The business lines are filled from it automatically."),
        items: [[L("事業（営業等）の収入", "事業（營業等）收入", "Business receipts"), yen(biz.sales)], [L("事業（営業等）の所得", "事業（營業等）所得", "Business income"), yen(r.businessIncomeAfterBlue)],
          [L("給与所得", "薪資所得", "Salary income"), v(input.salaryIncome)], [L("その他の所得", "其他所得", "Other income"), v(input.otherIncome)]] },
      { title: L("3. 所得から差し引かれる金額（所得控除）", "3. 所得扣除", "3. Deductions"),
        body: L("各控除の画面で、証明書の金額を入力します（控除額は作成コーナーが計算します）。", "在各扣除畫面輸入證明書上的金額（扣除額由作成コーナー計算）。", "On each deduction screen, type the amounts on the certificates (the site computes the deduction)."),
        items: [[L("社会保険料控除", "社會保險費扣除", "Social insurance"), v(input.socialInsurance)], [L("小規模企業共済等掛金控除", "小規模企業共済等掛金扣除", "iDeCo / mutual aid"), v(input.smallBizMutual)],
          [L("生命保険料控除（一般／介護医療／個人年金の支払額）", "人壽保險扣除（一般／介護醫療／個人年金支付額）", "Life insurance (paid: general / medical / pension)"), [input.lifeGeneral, input.lifeCare, input.lifePension].map((x) => (x ? yen(x) : "—")).join(" / ")],
          [L("地震保険料控除", "地震保險扣除", "Earthquake insurance"), v(input.earthquake)], [L("医療費控除（支払額−補填額）", "醫療費扣除（支付額−補償額）", "Medical (paid − reimbursed)"), input.medicalPaid ? `${yen(input.medicalPaid)} − ${yen(input.medicalReimbursed || 0)}` : v(0)],
          [L("寄附金控除（ふるさと納税）", "捐款扣除（故鄉納稅）", "Donations"), v(input.donations)], [L("配偶者控除", "配偶者扣除", "Spouse"), input.spouse ? L("あり", "有", "Yes") : v(0)],
          [L("扶養控除", "扶養扣除", "Dependants"), (input.dependents || input.specialDependents) ? `${input.dependents || 0} + ${input.specialDependents || 0}` : v(0)], [L("基礎控除（自動）", "基礎扣除（自動）", "Basic deduction (automatic)"), yen(r.deductions.basic)]] },
      { title: L("4. 源泉徴収税額・予定納税額", "4. 源泉徵收稅額、預定納稅額", "4. Withheld and prepaid tax"),
        body: L("報酬から引かれた源泉徴収税額は「源泉徴収税額」の欄に（支払者ごとに入力する画面もあります）。", "報酬被預扣的稅額填在「源泉徴収税額」欄（也有依付款人逐筆輸入的畫面）。", "Tax withheld from fees goes in 源泉徴収税額 (there is a per-payer screen)."),
        items: [[L("源泉徴収税額（報酬＋給与）", "源泉徵收稅額（報酬＋薪資）", "Withheld (fees + salary)"), v((input.withheldFees || 0) + (input.withheldSalary || 0))], [L("予定納税額", "預定納稅額", "Prepaid"), v(input.prepaid)]] },
      { title: L("5. 結果を確認して送信", "5. 確認結果並送出", "5. Check and submit"),
        body: L("作成コーナーの計算結果が下の見込み額とほぼ同じか確認。住民税の徴収方法は「自分で納付」を選びます。最後にマイナンバーカードで送信。納付は振替納税（口座振替）が便利です。",
          "確認作成コーナー的計算結果和下方預估差不多。住民稅繳納方式選「自分で納付」。最後用個人番號卡送出。繳稅用振替納税（帳戶扣款）最方便。",
          "Check the site's result is close to the estimate below. For resident tax choose 自分で納付. Submit with your My Number card; pay by 振替納税 (direct debit)."),
        items: [[r.refund ? L("還付される税金（見込み）", "可退稅額（預估）", "Refund (estimate)") : L("納める税金（見込み）", "應繳稅額（預估）", "Tax to pay (estimate)"), yen(r.refund || r.due)]] },
    ];
  }

  /**
   * Steps on 作成コーナー (消費税) for the chosen method.
   * @param {any} a ConsumptionTax.aggregate() @param {any} m chosen method @param {string} lang @param {(n: number) => string} yen
   */
  function consumptionSteps(a, m, kind, lang, yen) {
    const L = (ja, zh, en) => ({ ja, zh, en })[lang] || ja;
    const name = { general: L("一般課税（本則）", "一般課稅（本則）", "Standard"), niwari: L("2割特例", "2割特例", "20% special rule"), sanwari: L("3割特例", "3割特例", "30% special rule"), simple: L("簡易課税", "簡易課稅", "Simplified") }[m.key];
    const items = [[L("課税売上高（税込）10%", "課稅銷售額（含稅）10%", "Taxable sales (incl.) 10%"), yen(a.sales10)], [L("課税売上高（税込）8%", "課稅銷售額（含稅）8%", "Taxable sales (incl.) 8%"), yen(a.sales8)]];
    if (m.key === "general") items.push(
      [L("課税仕入高（税込）10%・適格請求書あり", "課稅進項（含稅）10%・有適格請求書", "Purchases (incl.) 10%, with invoice"), yen(a.q10)], [L("課税仕入高（税込）8%・適格請求書あり", "課稅進項（含稅）8%・有適格請求書", "Purchases (incl.) 8%, with invoice"), yen(a.q8)],
      [L("適格請求書なし（経過措置の対象）10% / 8%", "無適格請求書（過渡措施）10% / 8%", "Without invoice (transitional) 10% / 8%"), `${yen(a.n10)} / ${yen(a.n8)}`]);
    if (m.key === "simple") items.push([L("事業区分", "事業區分", "Business category"), L(`第${kind}種`, `第 ${kind} 種`, `Type ${kind}`)]);
    items.push([L("消費税（国税）", "消費稅（國稅）", "Consumption tax (national)"), yen(m.national)], [L("地方消費税", "地方消費稅", "Local consumption tax"), yen(m.local)], [L("合計納付税額", "合計應繳", "Total to pay"), yen(m.total)]);
    return [{ title: L(`作成コーナー →「消費税」→「${name}」を選択`, `作成コーナー →「消費税」→ 選「${name}」`, `作成コーナー → 消費税 → choose ${name}`),
      body: L("下の金額をそのまま入力すると、税額が同じになるはずです。期限は3月31日。", "照下面的金額輸入，稅額應該會一樣。期限 3 月 31 日。", "Type these figures; the tax should match. Deadline: 31 March."), items }];
  }

  const api = { FIELDS, text, incomeSteps, consumptionSteps };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaxGuide = api;
})(typeof window !== "undefined" ? window : globalThis);
