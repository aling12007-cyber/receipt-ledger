// Receipt Ledger — plain-language bookkeeping tips for people who are not accountants.
// One short sentence per account, per payment account and per form field, in ja / zh / en.
// Exposes window.Tips (and module.exports for tests).
(function (root) {
  /** @type {Record<string, { ja: string, zh: string, en: string }>} */
  const ACCOUNT = {
    旅費交通費: { ja: "電車・バス・タクシー・出張の宿泊など、仕事の移動にかかった費用。定期券も含みます。", zh: "工作移動的費用：電車、公車、計程車、出差住宿等，月票也算。", en: "Travel for work: trains, buses, taxis, business-trip hotels, commuter passes." },
    通信費: { ja: "携帯・ネット回線・切手・宅配の書類送付など。私用と兼ねるなら事業比例を下げます。", zh: "手機、網路、郵票、寄文件等。如果也私人使用，請調低事業比例。", en: "Phone, internet, stamps, sending documents. Lower the business-use % if you also use it privately." },
    消耗品費: { ja: "文房具・日用品・10万円未満のパソコン周辺機器など、すぐ使う物。10万円以上は固定資産です。", zh: "文具、日用品、未滿10萬日圓的電腦周邊等消耗品。10萬以上要列固定資產。", en: "Supplies and items under ¥100,000 (stationery, accessories). ¥100,000 or more is a fixed asset." },
    会議費: { ja: "取引先との打合せの飲食代（目安1人1万円以下）。摘要に「相手の会社名・人数」を書いておくと安心です。", zh: "和客戶開會時的餐飲費（大約每人1萬日圓以下）。摘要寫上「對方公司名、人數」最保險。", en: "Food and drink at business meetings (roughly up to ¥10,000 per person). Note the company and how many attended." },
    接待交際費: { ja: "取引先の接待・お中元・お祝い・ゴルフなど。誰をもてなしたかを摘要や備考に残します。", zh: "招待客戶、送禮、祝賀、打高爾夫等。在摘要或備考寫下招待了誰。", en: "Entertaining clients, gifts, golf with clients. Note who you entertained." },
    新聞図書費: { ja: "仕事に使う本・雑誌・新聞・有料の情報サービス。", zh: "工作用的書籍、雜誌、報紙、付費資訊服務。", en: "Books, magazines, newspapers and paid information services for work." },
    広告宣伝費: { ja: "広告・チラシ・名刺・ウェブ広告・ホームページ制作など、お客さんを集めるための費用。", zh: "廣告、傳單、名片、網路廣告、網站製作等招攬客人的費用。", en: "Ads, flyers, business cards, web ads, website building." },
    支払手数料: { ja: "振込手数料・決済サービスの手数料・仲介手数料など。", zh: "匯款手續費、刷卡/金流手續費、仲介費等。", en: "Bank transfer fees, payment-service fees, brokerage fees." },
    外注工賃: { ja: "仕事の一部を外部の人や会社に頼んだ報酬。源泉徴収が必要な場合があります。", zh: "把部分工作外包給別人或公司的報酬。有時需要預扣所得稅。", en: "Paying outside people or firms to do part of the work. Withholding tax may apply." },
    地代家賃: { ja: "事務所・店舗・駐車場の家賃。自宅兼事務所なら仕事で使う割合だけ（事業比例）を経費にします。", zh: "辦公室、店面、停車場的租金。住家兼辦公室時只把工作使用的比例算經費。", en: "Rent for office, shop or parking. For a home office, only the business share counts." },
    水道光熱費: { ja: "電気・ガス・水道。自宅と兼用なら事業比例（家事按分）を設定します。", zh: "電費、瓦斯、水費。和住家共用時請設定事業比例（家事按分）。", en: "Electricity, gas, water. Set the business-use share if shared with your home." },
    荷造運賃: { ja: "商品の発送費・梱包材など、お客さんへ物を送る費用。", zh: "寄商品給客人的運費、包材。", en: "Shipping goods to customers and packing materials." },
    研修費: { ja: "仕事のためのセミナー・講座・資格試験の費用。", zh: "為工作參加的研討會、課程、證照考試費用。", en: "Seminars, courses and exams for your work." },
    修繕費: { ja: "パソコン・設備・事務所の修理代。性能を上げる改良は固定資産になることがあります。", zh: "電腦、設備、辦公室的修理費。若是升級性能，可能要列固定資產。", en: "Repairs. Upgrades that add value may be a fixed asset instead." },
    損害保険料: { ja: "事務所の火災保険・自動車保険など事業の保険。生命保険は経費ではありません。", zh: "辦公室火險、車險等事業用保險。人壽保險不是經費。", en: "Business insurance (fire, car). Life insurance is not an expense." },
    租税公課: { ja: "印紙・事業税・固定資産税・自動車税など。所得税・住民税は経費になりません。", zh: "印花稅、事業稅、固定資產稅、汽車稅等。所得稅、住民稅不能算經費。", en: "Stamp duty, business tax, property and car tax. Income and resident tax are not expenses." },
    福利厚生費: { ja: "従業員のための費用（健康診断・慰労会など）。事業主本人だけの分は対象外です。", zh: "為員工支出的費用（健康檢查、慰勞聚餐）。只有老闆本人的不算。", en: "Costs for employees (health checks, staff parties). Not for the owner alone." },
    給料賃金: { ja: "従業員への給料。家族への給料は青色事業専従者給与の届出が必要です。", zh: "付給員工的薪水。付給家人需先申報青色事業專從者給與。", en: "Wages for employees. Paying family members needs a separate filing." },
    利子割引料: { ja: "事業用の借入金の利息。元本の返済は経費ではありません。", zh: "事業借款的利息。償還本金不是經費。", en: "Interest on business loans. Repaying the principal is not an expense." },
    減価償却費: { ja: "固定資産の購入額を耐用年数で分けて経費にしたもの。決算・申告の画面で自動計算します。", zh: "把固定資產的購入金額按耐用年數分攤成經費。在決算畫面會自動計算。", en: "A fixed asset's cost spread over its useful life. Calculated automatically at year-end." },
    仕入高: { ja: "販売するための商品・材料の購入。", zh: "為了販售而購買的商品或材料。", en: "Goods or materials bought for resale." },
    雑費: { ja: "どの科目にも当てはまらない少額の費用。多用せず、できるだけ他の科目を選びます。", zh: "不屬於任何科目的小額費用。盡量少用，優先選其他科目。", en: "Small costs that fit nowhere else. Use sparingly." },
    売上高: { ja: "本業の売上。請求した時点（または入金時）で記帳します。", zh: "本業的營業收入。在開請款單時（或入帳時）記帳。", en: "Sales from your main business." },
    売掛金: { ja: "請求済みでまだ入金されていないお金。入金されたら「入金」で消し込みます。", zh: "已請款但還沒收到的錢。收到款項時用「入金」沖銷。", en: "Billed but not yet received. Clear it with “Payment received”." },
  };

  /** Credit side: how it was paid. */
  const PAYMENT = {
    未払金: { ja: "カード払い・後払いなど、まだ口座から引き落とされていない支払い。引き落とし日に「カード・未払金の支払」で消します。", zh: "刷卡、後付款等還沒從帳戶扣款的支出。扣款日用「信用卡・未払金的支付」沖銷。", en: "Card or pay-later: not yet taken from the bank. Clear it on the debit date with “Card / payable paid”." },
    現金: { ja: "事業用の財布・レジの現金。現金で払った／受け取った場合に使います。", zh: "事業用錢包或收銀機裡的現金。用現金付款或收款時使用。", en: "The business cash box: cash paid out or taken in." },
    普通預金: { ja: "事業用の銀行口座。振込・引き落としで直接払った／入金された場合に使います。", zh: "事業用的銀行帳戶。直接匯款、扣款付錢，或款項匯入時使用。", en: "The business bank account: paid by transfer or direct debit, or money received." },
    事業主借: { ja: "個人のお財布・個人口座から事業の費用を払った場合。返す必要はありません。", zh: "用自己的私人錢包或個人帳戶付了事業費用時。不需要還。", en: "Paid business costs with your personal money. Nothing to pay back." },
    事業主貸: { ja: "事業のお金を私用に使った場合や、入金が個人口座に入った場合。", zh: "事業的錢被私人使用，或款項匯入個人帳戶時。", en: "Business money used privately, or income received into a personal account." },
  };

  /** Form fields. */
  const FIELD = {
    debit: { ja: "勘定科目＝お金を「何に」使ったか。迷ったら一番近いものを選べば大丈夫です。", zh: "勘定科目＝錢「花在什麼上」。不確定時選最接近的就好。", en: "Account = what the money was for. Pick the closest one if unsure." },
    credit: { ja: "貸方＝お金を「どうやって」払ったか。カード払いは未払金を選びます。", zh: "貸方＝錢「用什麼方式」付的。刷卡請選未払金。", en: "Credit = how it was paid. Choose 未払金 for card payments." },
    ratio: { ja: "事業比例（家事按分）：私用と兼ねる物は仕事で使う割合だけを経費にします（例：携帯60％）。", zh: "事業比例（家事按分）：公私共用的東西只把工作用的比例算經費（例：手機60%）。", en: "Business-use %: for things also used privately, only the work share is an expense (e.g. phone 60%)." },
    ratioPart: { ja: "残り{p}％は私用分として「事業主貸」に自動で振り分けます。", zh: "剩下的{p}%會自動記為私人用的「事業主貸」。", en: "The other {p}% is booked to 事業主貸 (private use) automatically." },
    invoice: { ja: "登録番号（T＋13桁）がある領収書は消費税を全額控除できます。ない場合は一部（2026年10月から50％）のみです。", zh: "有登錄番號（T＋13位數）的收據，消費稅可以全額扣抵；沒有的話只能扣一部分（2026年10月起50%）。", en: "With a registration no. (T + 13 digits) the full consumption tax is credited; without it only part (50% from Oct 2026)." },
    items: { ja: "摘要：何のための支払いかを短く。後から見て分かるように書きます。", zh: "摘要：簡短寫下這筆錢的用途，讓日後看得懂。", en: "Description: a few words on what it was for, so you can tell later." },
    placeholder: { ja: "摘要の「○○」を相手の会社名に書き換えましょう。", zh: "請把摘要裡的「○○」改成對方的公司名稱。", en: "Replace “○○” in the description with the other company's name." },
    tax: { ja: "金額は税込で入力。10％と8％（食品の持ち帰りなど）を分け、切手・印紙・保険料などは「対象外」へ。", zh: "金額請輸入含稅價。10%和8%（外帶食品等）分開；郵票、印花、保險費等填在「非課稅」。", en: "Enter tax-included amounts. Split 10% and 8% (takeout food); stamps, revenue stamps and insurance go under non-taxable." },
  };

  /** Reading guides shown above the reports. */
  const READ = {
    journal: { ja: "仕訳帳：すべての取引を日付順に並べた帳簿。左（借方）が「増えた費用・資産」、右（貸方）が「お金の出どころ」です。", zh: "仕訳帳：依日期列出所有交易。左邊（借方）是「增加的費用或資產」，右邊（貸方）是「錢從哪裡來」。", en: "Journal: every transaction by date. Left (debit) is the cost or asset that increased; right (credit) is where the money came from." },
    ledger: { ja: "総勘定元帳：科目ごとの出入りと残高。上の欄で科目を選ぶと、その科目の動きが分かります。「相手科目」は反対側の科目です。", zh: "總勘定元帳：每個科目的進出和餘額。在上方選科目，就能看那個科目的變化。「對方科目」是另一邊的科目。", en: "General ledger: ins, outs and the balance per account. Pick an account above. “Other account” is the opposite side." },
    tb: { ja: "試算表：全科目の合計。借方合計と貸方合計が一致していれば帳簿のつじつまは合っています。", zh: "試算表：所有科目的合計。借方合計和貸方合計一致，就表示帳本是平衡的。", en: "Trial balance: totals of every account. If debit and credit totals match, the books are consistent." },
  };

  const pick = (o, lang) => (o ? o[lang] || o.ja : "");
  const api = {
    ACCOUNT, PAYMENT, FIELD, READ,
    /** @param {string} name @param {string} lang */
    account: (name, lang) => pick(ACCOUNT[name], lang),
    /** @param {string} name @param {string} lang */
    payment: (name, lang) => pick(PAYMENT[name], lang),
    /** @param {string} key @param {string} lang @param {Record<string, string|number>} [vars] */
    field: (key, lang, vars = {}) => pick(FIELD[key], lang).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")),
    /** @param {string} key @param {string} lang */
    read: (key, lang) => pick(READ[key], lang),
    /**
     * The tips for a form, most useful first: one per account in use, then the description / 家事按分 / invoice hints.
     * @param {{ accounts: string[], bizRatio?: number, invoiceNo?: string, items?: string, expense?: boolean }} d
     * @param {string} lang
     * @returns {Array<{ kind: string, name?: string, text: string }>}
     */
    forDraft(d, lang) {
      const out = [];
      for (const a of [...new Set(d.accounts.filter(Boolean))]) {
        if (ACCOUNT[a]) out.push({ kind: "account", name: a, text: pick(ACCOUNT[a], lang) });
        else if (PAYMENT[a]) out.push({ kind: "account", name: a, text: pick(PAYMENT[a], lang) });
      }
      if (/○○/.test(d.items || "")) out.push({ kind: "items", text: api.field("placeholder", lang) });
      const r = Number(d.bizRatio ?? 100);
      if (d.expense && r < 100) out.push({ kind: "ratio", text: api.field("ratio", lang) + " " + api.field("ratioPart", lang, { p: 100 - r }) });
      if (d.expense && !/^T\d{13}$/.test(d.invoiceNo || "")) out.push({ kind: "invoice", text: api.field("invoice", lang) });
      return out;
    },
    /** The basics, always available under the tips. @param {string} lang */
    basics: (lang) => ["debit", "credit", "tax", "items", "ratio"].map((k) => ({ kind: k, text: api.field(k, lang) })),
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Tips = api;
})(typeof window !== "undefined" ? window : globalThis);
