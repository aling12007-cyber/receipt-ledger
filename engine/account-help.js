// Receipt Ledger — what each account means, with everyday examples and the usual mix-ups (ja / zh / en).
// Plain-language help for people who are not accountants; not tax advice for a particular case.
// Exposes window.AccountHelp (and module.exports for tests).
(function (root) {
  /** @type {Record<string, { ja: string, zh: string, en: string }>} */
  const HELP = {
    旅費交通費: { ja: "電車・バス・タクシー・新幹線・飛行機・出張の宿泊費・駐車場・高速代。例：打合せ先への電車代。", zh: "電車、公車、計程車、新幹線、機票、出差住宿、停車費、高速公路費。例：去開會的車資。", en: "Trains, buses, taxis, flights, business-trip hotels, parking, tolls. E.g. the fare to a client meeting." },
    通信費: { ja: "携帯電話・インターネット・切手・はがき・レターパック。サーバー・ドメインなどのネット利用料もここ。自宅と兼用なら按分。", zh: "手機、網路、郵票、明信片、Letter Pack。伺服器、網域等網路服務費也算。和私人共用要按分。", en: "Phone, internet, stamps, postcards; servers and domains too. Split if shared with private use." },
    消耗品費: { ja: "10万円未満の備品・文房具・ソフト・周辺機器。10万円以上は固定資産（減価償却）になります。", zh: "未滿 10 萬的用品、文具、軟體、周邊設備。10 萬以上要列固定資產（折舊）。", en: "Equipment, stationery, software under ¥100,000. ¥100,000 or more is a fixed asset (depreciated)." },
    会議費: { ja: "打合せのための飲食（カフェ・会議室・軽食）。相手と目的を備考に。お酒を伴う接待は接待交際費。", zh: "為了開會的餐飲（咖啡、會議室、輕食）。備註寫對象和目的。有喝酒的招待算交際費。", en: "Food and drink for a business meeting (café, room, snacks). Note who and why. Entertaining with alcohol is 接待交際費." },
    接待交際費: { ja: "取引先との会食・お中元・お歳暮・お祝い・手土産。仕事の関係がわかるように相手を記録。", zh: "和客戶聚餐、中元、歲末禮品、賀禮、伴手禮。記下對象，讓工作關係清楚。", en: "Dinners with clients, seasonal gifts, congratulations. Record who it was for." },
    新聞図書費: { ja: "仕事に使う本・雑誌・新聞・電子書籍・有料記事の購読。", zh: "工作用的書、雜誌、報紙、電子書、付費文章訂閱。", en: "Books, magazines, newspapers, e-books and paid articles for work." },
    広告宣伝費: { ja: "広告・名刺・チラシ・ホームページ制作・SNS広告・ポートフォリオ印刷。", zh: "廣告、名片、傳單、網站製作、社群廣告、作品集印刷。", en: "Ads, business cards, flyers, website building, social ads, portfolio printing." },
    支払手数料: { ja: "振込手数料・決済サービスの手数料・仲介手数料・税理士などへの報酬。", zh: "匯款手續費、金流服務手續費、仲介費、稅理士等報酬。", en: "Bank transfer fees, payment-service fees, brokerage, accountant fees." },
    外注工賃: { ja: "仕事の一部を外部の人・会社に頼んだ代金（デザイン・撮影・翻訳など）。", zh: "把部分工作委託外部人員或公司的費用（設計、攝影、翻譯等）。", en: "Paying outside people or firms for part of the work (design, photos, translation)." },
    地代家賃: { ja: "事務所・倉庫・駐車場の家賃。自宅兼事務所なら仕事で使う割合だけ（家事按分）。", zh: "辦公室、倉庫、停車位的租金。住家兼辦公室只算工作使用比例（家事按分）。", en: "Rent for an office, storage or parking. At home, only the business share." },
    水道光熱費: { ja: "電気・ガス・水道。自宅兼事務所なら仕事で使う割合だけ。", zh: "電、瓦斯、水。住家兼辦公室只算工作使用比例。", en: "Electricity, gas, water. At home, only the business share." },
    荷造運賃: { ja: "商品や作品を送る送料・梱包材・宅配便。", zh: "寄送商品或作品的運費、包材、宅配。", en: "Shipping, packing materials and couriers for goods or work." },
    研修費: { ja: "セミナー・講座・勉強会の参加費（仕事に必要なもの）。", zh: "工作需要的研討會、課程、讀書會費用。", en: "Seminars, courses and study sessions needed for the work." },
    修繕費: { ja: "仕事で使う機器・設備の修理代。性能が上がる改造は資産になることがあります。", zh: "工作用設備的修理費。提升性能的改造可能要列資產。", en: "Repairs to work equipment. Upgrades that add value may be assets." },
    損害保険料: { ja: "事務所の火災保険・仕事用の賠償責任保険など。自分の生命保険は経費ではなく所得控除。", zh: "辦公室火險、工作用責任險等。自己的人壽保險不是經費，是所得扣除。", en: "Office fire insurance, liability insurance for work. Your life insurance is a deduction, not an expense." },
    租税公課: { ja: "収入印紙・個人事業税・事業用の固定資産税・自動車税など。所得税・住民税は経費になりません。", zh: "印花稅票、個人事業稅、事業用固定資產稅、汽車稅等。所得稅、住民稅不能列經費。", en: "Revenue stamps, business tax, property tax on business assets. Income and resident tax are not expenses." },
    福利厚生費: { ja: "従業員のための健康診断・慰安など。自分だけのための支出は対象外。", zh: "為員工的健檢、慰勞等。只為自己的支出不算。", en: "Health checks and welfare for employees; not for yourself alone." },
    給料賃金: { ja: "従業員・アルバイトへの給与。家族への給与は青色事業専従者給与の届出が必要。", zh: "員工、工讀生的薪資。付給家人需先申報青色事業專從者給與。", en: "Wages for employees and part-timers. Family wages need the 専従者給与 notification." },
    利子割引料: { ja: "事業のための借入金の利息。元本の返済は経費になりません。", zh: "事業借款的利息。償還本金不是經費。", en: "Interest on business loans. Repaying the principal is not an expense." },
    減価償却費: { ja: "固定資産の取得費を耐用年数で分けた今年の分。固定資産台帳から自動で計算されます。", zh: "固定資產取得成本依耐用年數分攤的今年份。由固定資產台帳自動計算。", en: "This year's share of a fixed asset's cost, calculated from the asset register." },
    仕入高: { ja: "売るために仕入れた商品・材料。", zh: "為了銷售而進的商品、材料。", en: "Goods and materials bought to sell." },
    雑費: { ja: "どの科目にも当てはまらない少額の支出。多くなりすぎたら専用の科目を検討。", zh: "不屬於任何科目的小額支出。太多時考慮改用專門科目。", en: "Small costs that fit nowhere else. If it grows, use a proper account." },
    事業主借: { ja: "個人のお金・個人のカードで仕事の支払いをしたとき。返す必要はありません。", zh: "用個人的錢、個人信用卡付工作支出時使用。不需要還。", en: "Business costs paid with personal money or a personal card. Nothing to pay back." },
    事業主貸: { ja: "事業のお金を生活費などに使ったとき（私用の引き出し）。", zh: "把事業的錢拿去當生活費等（私人提領）。", en: "Business money used privately (drawings)." },
    未払金: { ja: "事業用クレジットカードなど、後で支払うもの。引落し日に普通預金から支払います。", zh: "事業用信用卡等之後才付款的。扣款日從銀行存款支付。", en: "Paid later, e.g. a business credit card; settled from the bank on the debit date." },
    売掛金: { ja: "請求書を出したがまだ入金されていない売上。", zh: "已開請款單但還沒收到錢的營收。", en: "Invoiced sales not yet paid." },
    普通預金: { ja: "事業用の銀行口座。", zh: "事業用的銀行帳戶。", en: "The business bank account." },
    現金: { ja: "事業用の現金。", zh: "事業用的現金。", en: "Business cash." },
    売上高: { ja: "仕事の売上（報酬・販売代金）。", zh: "工作的營收（報酬、銷售款）。", en: "Sales (fees and sales of goods)." },
  };
  /** @param {string} account @param {string} lang */
  const text = (account, lang) => { const h = HELP[account]; return h ? h[/** @type {"ja"|"zh"|"en"} */ (lang)] || h.ja : ""; };
  const api = { HELP, text };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AccountHelp = api;
})(typeof window !== "undefined" ? window : globalThis);
