// Golden Test Cases — Japanese sole proprietor (個人事業主), tax year 2026.
// These are the specification for the Journal / Ledger / Tax / Closing engines (Accounting Core Completion Plan).
// Amounts are invented and chosen so tax divides exactly; no real receipts or personal data.
//
// Defaults for every case unless it says otherwise:
//   青色申告 65万円控除 · 消費税 課税事業者 · 本則課税 · 税込経理
//
// Shape of a case:
//   journal:  the posted journal entries the engine must produce. Line = L(account, dr, cr, taxCode, taxAmount)
//   expect:   figures that must follow from the journal (trial balance, P&L, filing, consumption tax, checks)
//   legacy:   how today's app (one row per receipt, books.js) records the same thing, when it can.
//             legacy.covers = which journal entries the legacy rows stand for (default: all).
//   gap:      what today's app cannot record (the engine work that closes it)
//   Entries count as having a qualified invoice (or an exemption) unless they say qualified: false.

// 税区分 (tax codes). Rates come from the versioned tax rules, not from these labels.
export const TAX = {
  P10: "課税仕入 10%", P8: "課税仕入 8%（軽減）", PN: "非課税仕入", PX: "対象外（不課税）",
  S10: "課税売上 10%", S8: "課税売上 8%（軽減）", SN: "非課税売上", SE: "免税売上", SX: "対象外（不課税売上）",
  "-": "なし（資産・負債・資本の移動）",
};

// Chart of accounts the engine starts with (勘定科目). type: asset / liability / equity / revenue / expense.
export const CHART = {
  現金: "asset", 普通預金: "asset", 売掛金: "asset", 未収入金: "asset", 前払金: "asset", 仮払金: "asset", 工具器具備品: "asset", 車両運搬具: "asset",
  買掛金: "liability", 未払金: "liability", 未払費用: "liability", 前受金: "liability", 借入金: "liability", 預り金: "liability",
  元入金: "equity", 事業主借: "equity", 事業主貸: "equity",
  売上高: "revenue", 雑収入: "revenue",
  仕入高: "expense", 給料賃金: "expense", 外注工賃: "expense", 地代家賃: "expense", 水道光熱費: "expense", 通信費: "expense", 旅費交通費: "expense",
  接待交際費: "expense", 会議費: "expense", 消耗品費: "expense", 新聞図書費: "expense", 広告宣伝費: "expense", 支払手数料: "expense", 修繕費: "expense",
  車両費: "expense", 荷造運賃: "expense", 租税公課: "expense", 損害保険料: "expense", 減価償却費: "expense", 貸倒金: "expense", 利子割引料: "expense",
  福利厚生費: "expense", 研修費: "expense", 雑費: "expense",
};

export const L = (account, dr, cr, tax = "-", taxAmount = 0) => ({ account, dr, cr, tax, taxAmount });
const E = (date, lines, more = {}) => ({ date, kind: "normal", lines, ...more });
const X = (o) => ({ type: "expense", amt10: 0, amt8: 0, amt0: 0, bizRatio: 100, ...o }); // legacy expense row
const I = (o) => ({ type: "income", amt10: 0, amt8: 0, amt0: 0, ...o });                 // legacy income row

const MACBOOK = { id: "a1", name: "MacBook Pro", date: "2026-04", cost: 440000, life: 4, method: "sl", ratio: 80, cat: "工具器具備品", paidFrom: "普通預金" };

// Shared dataset for the year-end cases 28–30
const YEAR_JOURNAL = [
  E("2026-04-01", [L("工具器具備品", 440000, 0, "P10", 40000), L("普通預金", 0, 440000)], { memo: "MacBook Pro" }),
  E("2026-12-31", [L("普通預金", 3300000, 0), L("売上高", 0, 3300000, "S10", 300000)], { memo: "売上（年合計）" }),
  E("2026-12-31", [L("地代家賃", 480000, 0, "PN"), L("事業主貸", 720000, 0), L("普通預金", 0, 1200000)], { memo: "自宅家賃（40%事業）" }),
  E("2026-12-31", [L("通信費", 132000, 0, "P10", 12000), L("普通預金", 0, 132000)]),
  E("2026-12-31", [L("消耗品費", 88000, 0, "P10", 8000), L("普通預金", 0, 88000)]),
  E("2026-12-31", [L("会議費", 33000, 0, "P10", 3000), L("普通預金", 0, 33000)]),
  E("2026-12-31", [L("減価償却費", 66000, 0), L("事業主貸", 16500, 0), L("工具器具備品", 0, 82500)], { kind: "closing", memo: "減価償却（定額法 4年 9か月 事業80%）" }),
];
const YEAR_LEGACY = {
  entries: [
    I({ date: "2026-12-31", debit: "普通預金", amt10: 3300000 }),
    X({ date: "2026-12-31", debit: "地代家賃", credit: "普通預金", amt0: 1200000, bizRatio: 40 }),
    X({ date: "2026-12-31", debit: "通信費", credit: "普通預金", amt10: 132000 }),
    X({ date: "2026-12-31", debit: "消耗品費", credit: "普通預金", amt10: 88000 }),
    X({ date: "2026-12-31", debit: "会議費", credit: "普通預金", amt10: 33000 }),
  ],
  assets: [MACBOOK],
  covers: [1, 2, 3, 4, 5],
};

export const CASES = [
  {
    id: "01", title: "現金で消耗品を購入",
    journal: [E("2026-01-10", [L("消耗品費", 3300, 0, "P10", 300), L("現金", 0, 3300)], { vendor: "文具店", invoiceNo: "T1234567890123" })],
    expect: { trialBalance: { 消耗品費: 3300, 現金: -3300 } },
    legacy: { entries: [X({ date: "2026-01-10", debit: "消耗品費", credit: "現金", amt10: 3300, invoiceNo: "T1234567890123" })] },
  },
  {
    id: "02", title: "クレジットカードで購入し、翌月口座から引落し",
    journal: [
      E("2026-01-15", [L("消耗品費", 5500, 0, "P10", 500), L("未払金", 0, 5500)]),
      E("2026-02-27", [L("未払金", 5500, 0), L("普通預金", 0, 5500)], { kind: "transfer", memo: "カード引落し" }),
    ],
    expect: { trialBalance: { 消耗品費: 5500, 未払金: 0, 普通預金: -5500 } },
    legacy: { entries: [X({ date: "2026-01-15", debit: "消耗品費", credit: "未払金", amt10: 5500 })], covers: [0] },
    gap: "カード引落し（未払金 / 普通預金）の振替仕訳を記帳できない",
  },
  {
    id: "03", title: "Amazon（適格請求書あり、カード払い）",
    journal: [E("2026-02-03", [L("消耗品費", 4400, 0, "P10", 400), L("未払金", 0, 4400)], { vendor: "アマゾンジャパン合同会社", invoiceNo: "T6040001084325", memo: "USBハブ" })],
    expect: { ctax: { creditable: 400 } },
    legacy: { entries: [X({ date: "2026-02-03", debit: "消耗品費", credit: "未払金", amt10: 4400, invoiceNo: "T6040001084325" })] },
  },
  {
    id: "04", title: "コンビニ：1枚のレシートに複数の科目（複合仕訳）",
    journal: [E("2026-09-20", [
      L("消耗品費", 715, 0, "P10", 65), L("租税公課", 200, 0, "PX"), L("通信費", 168, 0, "PN"), L("会議費", 162, 0, "P8", 12),
      L("現金", 0, 1245),
    ], { kind: "compound", vendor: "株式会社ファミリーマート", memo: "ボールペン・コピー用紙／収入印紙／切手／おにぎり" })],
    expect: { trialBalance: { 消耗品費: 715, 租税公課: 200, 通信費: 168, 会議費: 162, 現金: -1245 } },
    legacy: { entries: [
      X({ date: "2026-09-20", debit: "消耗品費", credit: "現金", amt10: 715, assetId: "r04" }),
      X({ date: "2026-09-20", debit: "租税公課", credit: "現金", amt0: 200, assetId: "r04" }),
      X({ date: "2026-09-20", debit: "通信費", credit: "現金", amt0: 168, assetId: "r04" }),
      X({ date: "2026-09-20", debit: "会議費", credit: "現金", amt8: 162, assetId: "r04" }),
    ] },
    gap: "今は4つの独立したデータで、1つの複合仕訳ではない（画像パスとメモだけで関連付け）",
  },
  {
    id: "05", title: "飲食（打合せ）",
    journal: [E("2026-03-05", [L("会議費", 2200, 0, "P10", 200), L("現金", 0, 2200)], { memo: "打合せ 2名" })],
    legacy: { entries: [X({ date: "2026-03-05", debit: "会議費", credit: "現金", amt10: 2200 })] },
  },
  {
    id: "06", title: "交通費（電車・公共交通機関特例）",
    journal: [E("2026-03-06", [L("旅費交通費", 1320, 0, "P10", 120), L("現金", 0, 1320)], { memo: "電車代" })],
    expect: { invoice: "対象外（公共交通機関特例）", ctax: { creditable: 120 } },
    legacy: { entries: [X({ date: "2026-03-06", debit: "旅費交通費", credit: "現金", amt10: 1320 })] },
  },
  {
    id: "07", title: "通信費（現金）",
    journal: [E("2026-09-01", [L("通信費", 11000, 0, "P10", 1000), L("現金", 0, 11000)])],
    expect: { trialBalance: { 通信費: 11000, 現金: -11000 } },
    legacy: { entries: [X({ date: "2026-09-01", debit: "通信費", credit: "現金", amt10: 11000 })] },
  },
  {
    id: "08", title: "事務所家賃（事業専用・課税）",
    journal: [E("2026-04-25", [L("地代家賃", 110000, 0, "P10", 10000), L("普通預金", 0, 110000)], { vendor: "株式会社〇〇不動産" })],
    legacy: { entries: [X({ date: "2026-04-25", debit: "地代家賃", credit: "普通預金", amt10: 110000 })] },
  },
  {
    id: "09", title: "自宅家賃の家事按分（事業40%・住宅家賃は非課税）",
    journal: [E("2026-04-27", [L("地代家賃", 40000, 0, "PN"), L("事業主貸", 60000, 0), L("普通預金", 0, 100000)])],
    expect: { trialBalance: { 地代家賃: 40000, 事業主貸: 60000, 普通預金: -100000 }, allocation: { account: "地代家賃", ratio: 40 } },
    legacy: { entries: [X({ date: "2026-04-27", debit: "地代家賃", credit: "普通預金", amt0: 100000, bizRatio: 40 })] },
  },
  {
    id: "10", title: "携帯電話の家事按分（事業60%）",
    journal: [E("2026-05-26", [L("通信費", 5280, 0, "P10", 480), L("事業主貸", 3520, 0), L("普通預金", 0, 8800)])],
    expect: { ctax: { creditable: 480 } },
    legacy: { entries: [X({ date: "2026-05-26", debit: "通信費", credit: "普通預金", amt10: 8800, bizRatio: 60 })] },
  },
  {
    id: "11", title: "MacBook を固定資産として取得（44万円・少額特例の対象外）",
    journal: [E("2026-04-01", [L("工具器具備品", 440000, 0, "P10", 40000), L("普通預金", 0, 440000)], { memo: "MacBook Pro" })],
    expect: { trialBalance: { 工具器具備品: 440000, 普通預金: -440000 }, ctax: { creditable: 40000 } },
    legacy: { entries: [], assets: [MACBOOK], covers: [] },
    gap: "固定資産は登録表にあるだけで、取得の仕訳がない",
  },
  {
    id: "12", title: "減価償却（定額法・耐用年数4年・4月取得・事業80%）",
    journal: [
      E("2026-04-01", [L("工具器具備品", 440000, 0, "P10", 40000), L("普通預金", 0, 440000)]),
      E("2026-12-31", [L("減価償却費", 66000, 0), L("事業主貸", 16500, 0), L("工具器具備品", 0, 82500)], { kind: "closing" }),
    ],
    expect: { depreciation: { dep: 82500, business: 66000, private: 16500, close: 357500 }, trialBalance: { 工具器具備品: 357500, 減価償却費: 66000, 事業主貸: 16500, 普通預金: -440000 } },
    legacy: { entries: [], assets: [MACBOOK], covers: [] },
    gap: "償却額は計算されるが、決算仕訳として帳簿に残らない",
  },
  {
    id: "13", title: "現金売上",
    journal: [E("2026-05-10", [L("現金", 55000, 0), L("売上高", 0, 55000, "S10", 5000)])],
    legacy: { entries: [I({ date: "2026-05-10", debit: "現金", amt10: 55000 })] },
  },
  {
    id: "14", title: "売掛金で売上（請求書発行）",
    journal: [E("2026-05-31", [L("売掛金", 330000, 0), L("売上高", 0, 330000, "S10", 30000)], { vendor: "株式会社△△", memo: "デザイン制作 5月分" })],
    legacy: { entries: [I({ date: "2026-05-31", debit: "売掛金", amt10: 330000 })] },
  },
  {
    id: "15", title: "売掛金の入金（振込手数料差引き）",
    journal: [
      E("2026-05-31", [L("売掛金", 330000, 0), L("売上高", 0, 330000, "S10", 30000)]),
      E("2026-06-30", [L("普通預金", 329340, 0), L("支払手数料", 660, 0, "P10", 60), L("売掛金", 0, 330000)], { kind: "compound" }),
    ],
    expect: { trialBalance: { 売掛金: 0, 普通預金: 329340, 支払手数料: 660, 売上高: -330000 } },
    legacy: { entries: [I({ date: "2026-05-31", debit: "売掛金", amt10: 330000 })], covers: [0] },
    gap: "入金（普通預金 / 売掛金）を記帳できない。今は期末残高の入力で差額処理している",
  },
  {
    id: "16", title: "事業主借：個人のカードで事業用の本を購入",
    journal: [E("2026-06-02", [L("新聞図書費", 2750, 0, "P10", 250), L("事業主借", 0, 2750)])],
    legacy: { entries: [X({ date: "2026-06-02", debit: "新聞図書費", credit: "事業主借", amt10: 2750 })] },
  },
  {
    id: "17", title: "事業主貸：事業用口座から生活費を引出し",
    journal: [E("2026-06-25", [L("事業主貸", 50000, 0), L("普通預金", 0, 50000)], { kind: "transfer" })],
    expect: { trialBalance: { 事業主貸: 50000, 普通預金: -50000 } },
    gap: "事業主貸の振替（事業主貸 / 普通預金）を記帳できない",
  },
  {
    id: "18", title: "8% 軽減税率（新聞の定期購読）",
    journal: [E("2026-07-01", [L("新聞図書費", 4320, 0, "P8", 320), L("現金", 0, 4320)])],
    expect: { ctax: { creditable: 320 } },
    legacy: { entries: [X({ date: "2026-07-01", debit: "新聞図書費", credit: "現金", amt8: 4320 })] },
  },
  {
    id: "19", title: "10% 標準税率（広告）",
    journal: [E("2026-07-10", [L("広告宣伝費", 22000, 0, "P10", 2000), L("未払金", 0, 22000)], { invoiceNo: "T1111111111111" })],
    expect: { ctax: { creditable: 2000 } },
    legacy: { entries: [X({ date: "2026-07-10", debit: "広告宣伝費", credit: "未払金", amt10: 22000, invoiceNo: "T1111111111111" })] },
  },
  {
    id: "20", title: "非課税（火災保険料）",
    journal: [E("2026-07-15", [L("損害保険料", 24000, 0, "PN"), L("普通預金", 0, 24000)])],
    expect: { ctax: { creditable: 0 } },
    legacy: { entries: [X({ date: "2026-07-15", debit: "損害保険料", credit: "普通預金", amt0: 24000 })] },
  },
  {
    id: "21", title: "不課税（個人事業税）",
    journal: [E("2026-08-31", [L("租税公課", 30000, 0, "PX"), L("普通預金", 0, 30000)])],
    expect: { ctax: { creditable: 0 } },
    legacy: { entries: [X({ date: "2026-08-31", debit: "租税公課", credit: "普通預金", amt0: 30000 })] },
  },
  {
    id: "22", title: "インボイスあり（登録番号あり）",
    journal: [E("2026-09-15", [L("外注工賃", 55000, 0, "P10", 5000), L("普通預金", 0, 55000)], { invoiceNo: "T2222222222222" })],
    expect: { invoice: "確認済", ctax: { creditable: 5000 }, legacyBases: { q10: 55000, d10: 0 } },
    legacy: { entries: [X({ date: "2026-09-15", debit: "外注工賃", credit: "普通預金", amt10: 55000, invoiceNo: "T2222222222222" })] },
  },
  {
    id: "23", title: "インボイスなし（経過措置 80% → 2026-10-01 から 50%）",
    journal: [
      E("2026-09-15", [L("外注工賃", 55000, 0, "P10", 5000), L("普通預金", 0, 55000)], { qualified: false }),
      E("2026-10-15", [L("外注工賃", 55000, 0, "P10", 5000), L("普通預金", 0, 55000)], { qualified: false }),
    ],
    expect: { invoice: "要確認", ctax: { creditable: 6500 }, legacyBases: { q10: 0, n10: 110000, d10: 71500 } },
    legacy: { entries: [
      X({ date: "2026-09-15", debit: "外注工賃", credit: "普通預金", amt10: 55000 }),
      X({ date: "2026-10-15", debit: "外注工賃", credit: "普通預金", amt10: 55000 }),
    ] },
  },
  {
    id: "24", title: "同じレシートを2回アップロード",
    documents: [{ id: "d1", sha256: "a3f1…same", date: "2026-03-05", vendor: "喫茶店", total: 2200 }, { id: "d2", sha256: "a3f1…same", date: "2026-03-05", vendor: "喫茶店", total: 2200 }],
    journal: [E("2026-03-05", [L("会議費", 2200, 0, "P10", 200), L("現金", 0, 2200)], { documentId: "d1" })],
    expect: { checks: [{ level: "WARNING", code: "DUPLICATE_DOCUMENT", documents: ["d1", "d2"] }], documentsKept: 2 },
    gap: "重複検知がない（Google ドライブの同じファイルID以外）",
  },
  {
    id: "25", title: "OCR 金額不一致（品目 1,000 + 500、税 150、合計 1,560）",
    ocr: { items: [1000, 500], tax: 150, total: 1560 },
    journal: [],
    expect: { checks: [{ level: "ERROR", code: "AMOUNT_MISMATCH" }], canConfirm: false },
    gap: "小計＋税＝合計の検証と「確定禁止」がない",
  },
  {
    id: "26", title: "年度繰越（2026 → 2027 の開始仕訳）",
    journal: [
      E("2026-01-01", [L("現金", 100000, 0), L("普通預金", 500000, 0), L("元入金", 0, 600000)], { kind: "opening" }),
      E("2026-12-31", [L("普通預金", 1100000, 0), L("売上高", 0, 1100000, "S10", 100000)], { memo: "売上（年合計）" }),
      E("2026-12-31", [L("外注工賃", 330000, 0, "P10", 30000), L("普通預金", 0, 330000)]),
      E("2026-12-31", [L("事業主貸", 200000, 0), L("普通預金", 0, 200000)], { kind: "transfer" }),
      E("2026-12-31", [L("消耗品費", 55000, 0, "P10", 5000), L("事業主借", 0, 55000)]),
    ],
    expect: {
      income: 715000,
      nextOpening: { year: 2027, lines: [L("現金", 100000, 0), L("普通預金", 1070000, 0), L("元入金", 0, 1170000)] },
      rule: "翌年の元入金 = 元入金 + 青色申告特別控除前の所得 + 事業主借 − 事業主貸",
    },
    gap: "繰越・開始仕訳がない（期首残高は毎年手入力）",
  },
  {
    id: "27", title: "決算整理（未払の電気代・電気代の家事按分を年末に一括）",
    journal: [
      E("2026-12-31", [L("水道光熱費", 132000, 0, "P10", 12000), L("普通預金", 0, 132000)], { memo: "電気代 1〜11月（全額で記帳）" }),
      E("2026-12-31", [L("水道光熱費", 8800, 0, "P10", 800), L("未払金", 0, 8800)], { kind: "closing", memo: "12月分（1月引落し）" }),
      E("2026-12-31", [L("事業主貸", 92400, 0), L("水道光熱費", 0, 92400, "P10", 8400)], { kind: "closing", memo: "家事按分 私用70%（1〜11月分）" }),
    ],
    expect: { trialBalance: { 水道光熱費: 48400, 事業主貸: 92400, 普通預金: -132000, 未払金: -8800 }, ctax: { creditable: 4400 } },
    gap: "決算整理仕訳（未払・年末の家事按分）を作れない",
  },
  {
    id: "28", title: "青色申告決算書（65万円控除）",
    journal: YEAR_JOURNAL,
    expect: {
      filing: { kind: "blue", sales: 3300000, rows: { 地代家賃: 480000, 通信費: 132000, 消耗品費: 88000, 減価償却費: 66000, 会議費: 33000 }, expenses: 799000, income: 2501000, deduction: 650000, taxable: 1851000 },
      knownBug: { dashboardIncome: 2567000, why: "Dashboard は減価償却費 66,000 円を引いていない" },
    },
    legacy: YEAR_LEGACY,
  },
  {
    id: "29", title: "白色申告（収支内訳書）",
    settings: { filing: "white" },
    journal: YEAR_JOURNAL,
    expect: { filing: { kind: "white", sales: 3300000, expenses: 799000, income: 2501000, deduction: 0, taxable: 2501000, form: "収支内訳書", balanceSheetRequired: false } },
    legacy: YEAR_LEGACY,
    gap: "白色申告でも青色の決算書の欄で表示される",
  },
  {
    id: "30", title: "確定申告書への引継ぎ（事業所得）",
    journal: YEAR_JOURNAL,
    expect: { taxReturn: { "収入金額等・事業・営業等（ア）": 3300000, "所得金額等・事業・営業等（①）": 1851000 } },
    gap: "確定申告書のデータモデルがない",
  },
];
