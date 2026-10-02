// Receipt Ledger — chart of accounts (勘定科目). Mirrors public.account_master in supabase/002_accounting_core.sql
// (a test keeps the two in sync). Exposes window.Accounts (and module.exports for tests).
(function (root) {
  /** @typedef {"asset"|"liability"|"equity"|"revenue"|"expense"} AccountType */
  /** @typedef {{ name: string, type: AccountType, filingLine: string|null, defaultTax: string, sort: number, en: string, zh: string }} Account */

  /** @type {Account[]} */
  const MASTER = [
    ["現金", "asset", "現金", "-", 100, "Cash", "現金"], ["普通預金", "asset", "その他の預金", "-", 110, "Bank account", "銀行存款"],
    ["売掛金", "asset", "売掛金", "-", 120, "Accounts receivable", "應收帳款"], ["未収入金", "asset", "未収入金", "-", 130, "Other receivables", "其他應收款"],
    ["棚卸資産", "asset", "棚卸資産", "-", 140, "Inventory", "存貨"], ["前払金", "asset", "前払金", "-", 150, "Prepayments", "預付款"],
    ["仮払金", "asset", "仮払金", "-", 160, "Suspense payments", "暫付款"], ["建物附属設備", "asset", "建物附属設備", "P10", 170, "Building fixtures", "建物附屬設備"],
    ["機械装置", "asset", "機械装置", "P10", 175, "Machinery", "機械設備"], ["車両運搬具", "asset", "車両運搬具", "P10", 180, "Vehicles", "車輛"],
    ["工具器具備品", "asset", "工具器具備品", "P10", 190, "Tools & equipment", "器具設備"],
    ["買掛金", "liability", "買掛金", "-", 200, "Accounts payable", "應付帳款"], ["未払金", "liability", "未払金", "-", 210, "Payable (card)", "應付款"],
    ["未払費用", "liability", "未払費用", "-", 220, "Accrued expenses", "應付費用"], ["前受金", "liability", "前受金", "-", 230, "Advances received", "預收款"],
    ["借入金", "liability", "借入金", "-", 240, "Loans", "借款"], ["預り金", "liability", "預り金", "-", 250, "Deposits held", "代收款"],
    ["元入金", "equity", "元入金", "-", 300, "Owner's capital", "業主資本"], ["事業主借", "equity", "事業主借", "-", 310, "Owner's contribution", "業主借入"],
    ["事業主貸", "equity", "事業主貸", "-", 320, "Owner's drawings", "業主提領"],
    ["売上高", "revenue", "売上（収入）金額", "S10", 400, "Sales", "營業收入"], ["雑収入", "revenue", "売上（収入）金額", "S10", 410, "Other income", "雜項收入"],
    ["仕入高", "expense", "仕入金額", "P10", 500, "Purchases", "進貨成本"], ["租税公課", "expense", "租税公課", "PX", 510, "Taxes & dues", "稅捐規費"],
    ["荷造運賃", "expense", "荷造運賃", "P10", 520, "Shipping", "運費"], ["水道光熱費", "expense", "水道光熱費", "P10", 530, "Utilities", "水電瓦斯"],
    ["旅費交通費", "expense", "旅費交通費", "P10", 540, "Travel & transport", "交通費"], ["通信費", "expense", "通信費", "P10", 550, "Communication", "通訊費"],
    ["広告宣伝費", "expense", "広告宣伝費", "P10", 560, "Advertising", "廣告費"], ["接待交際費", "expense", "接待交際費", "P10", 570, "Entertainment", "交際費"],
    ["損害保険料", "expense", "損害保険料", "PN", 580, "Insurance", "保險費"], ["修繕費", "expense", "修繕費", "P10", 590, "Repairs", "修繕費"],
    ["消耗品費", "expense", "消耗品費", "P10", 600, "Supplies", "消耗品"], ["減価償却費", "expense", "減価償却費", "-", 610, "Depreciation", "折舊"],
    ["福利厚生費", "expense", "福利厚生費", "P10", 620, "Welfare", "福利費"], ["給料賃金", "expense", "給料賃金", "PX", 630, "Wages", "薪資"],
    ["外注工賃", "expense", "外注工賃", "P10", 640, "Outsourcing", "外包費"], ["利子割引料", "expense", "利子割引料", "PN", 650, "Interest", "利息"],
    ["地代家賃", "expense", "地代家賃", "P10", 660, "Rent", "房租"], ["貸倒金", "expense", "貸倒金", "-", 670, "Bad debts", "呆帳"],
    ["会議費", "expense", null, "P10", 700, "Meetings", "會議費"], ["新聞図書費", "expense", null, "P10", 710, "Books & subscriptions", "書報費"],
    ["支払手数料", "expense", null, "P10", 720, "Fees & commissions", "手續費"], ["車両費", "expense", null, "P10", 730, "Vehicle costs", "車輛費"],
    ["研修費", "expense", null, "P10", 740, "Training", "研修費"], ["雑費", "expense", "雑費", "P10", 790, "Miscellaneous", "雜費"],
  ].map(([name, type, filingLine, defaultTax, sort, en, zh]) => /** @type {Account} */ ({ name, type, filingLine, defaultTax, sort, en, zh }));

  const BY_NAME = new Map(MASTER.map((a) => [a.name, a]));
  /** @param {string} name @returns {Account|undefined} */
  const get = (name) => BY_NAME.get(name);
  /** @param {string} name */
  const typeOf = (name) => (BY_NAME.get(name) || {}).type;
  /** @param {AccountType} type */
  const ofType = (type) => MASTER.filter((a) => a.type === type).map((a) => a.name);

  // How a payment method is booked (貸方 for an expense, 借方 for a sale)
  /** @type {Record<string, string>} */
  const PAYMENT_ACCOUNT = { cash: "現金", bank: "普通預金", card: "未払金", private: "事業主借", receivable: "売掛金", payable: "買掛金" };
  // Accounts that are usually shared with private life (家事按分)
  const MIXED_USE = new Set(["地代家賃", "水道光熱費", "通信費", "車両費", "損害保険料", "減価償却費"]);

  const api = { MASTER, get, typeOf, ofType, PAYMENT_ACCOUNT, MIXED_USE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Accounts = api;
})(typeof window !== "undefined" ? window : globalThis);
