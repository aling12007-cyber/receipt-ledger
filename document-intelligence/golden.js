// Receipt Ledger — Document Intelligence: golden test documents (invented shops, numbers and people — no real receipts).
// Each case is OCR-like text plus the expected reading, transaction and journal. Categories:
//   basic (convenience store, supermarket, restaurant, Amazon, Apple, electronics, transport, phone, rent)
//   tax (10% / 8% / 8%+10% / 非課税 / 不課税 / 免税 / 税抜) · invoice (with / without / smudged T number, several rates)
//   ocr (0/O, 1/I, 8/3, ¥, comma, decimal, wrong tax) · type (invoice, bill, delivery note, statements, contract) · duplicate
// Image defects (scan, phone photo, rotation, tilt, shadow, glare, blur, low resolution, cropping, dark background) are
// generated in tests/golden-images.test.js from invented images.
// Exposes window.DocGolden (and module.exports for tests).
(function (root) {
  const L = (...lines) => lines.join("\n");
  /**
   * expected: documentType, date, merchant (normalized), subtotal, tax (tax total), total, rates [[rate, tax-incl. amount]],
   *   invoice { value, status }, account, payment, validation ("ok" | "warning" | "error"), review (true = must need review),
   *   fixedAsset, entry (the journal input: debit, amt10, amt8, amt0; the credit follows the payment: cash → 事業主借, otherwise 未払金)
   */
  const CASES = [
    // ---------- basic ----------
    { id: "B01", category: "basic", title: "コンビニ（10%+8%、現金・お釣り）",
      text: L("ローソン テスト駅前店", "東京都千代田区テスト1-1-1", "TEL 03-0000-1111", "登録番号 T7000012050002", "2026年9月28日(月) 08:12", "レシートNo.1234",
        "ボールペン ¥330", "※おにぎり ¥162", "※お茶 ¥140", "小計 ¥632", "(10%対象 ¥330 内税 ¥30)", "(8%対象 ¥302 内税 ¥22)", "合計 ¥632", "お預り ¥1,000", "お釣り ¥368"),
      expected: { documentType: "receipt", date: "2026-09-28", merchant: "ローソン", subtotal: 632, tax: 52, total: 632, rates: [[10, 330], [8, 302]],
        invoice: { value: "T7000012050002", status: "registered" }, payment: "cash", validation: "ok",
        entry: { debit: "消耗品費", amt10: 330, amt8: 302, amt0: 0 } } },
    { id: "B02", category: "basic", title: "スーパー（8%中心、ポイント値引）",
      text: L("テストマート 新町店", "2026/09/27 18:40", "※牛乳 ¥248", "※食パン ¥198", "ゴミ袋 ¥398", "小計 ¥844", "ポイント値引 -¥44", "(10%対象 ¥370 内税 ¥33)", "(8%対象 ¥430 内税 ¥31)", "合計 ¥800", "クレジット ¥800"),
      expected: { documentType: "receipt", date: "2026-09-27", merchant: "テストマート", subtotal: 844, total: 800, rates: [[10, 370], [8, 430]], payment: "card",
        invoice: { value: null, status: "not_found" }, entry: { debit: "消耗品費", amt10: 370, amt8: 430, amt0: 0 } } },
    { id: "B03", category: "basic", title: "飲食店（打合せ、カード）",
      text: L("テスト食堂", "東京都港区テスト2-2-2", "登録番号 T1180301018771", "2026年09月26日 12:30", "ランチ 2名", "日替わり定食 ¥1,100", "日替わり定食 ¥1,100", "小計 ¥2,200", "(10%対象 ¥2,200 内消費税 ¥200)", "合計 ¥2,200", "VISA ¥2,200"),
      expected: { documentType: "receipt", date: "2026-09-26", merchant: "テスト食堂", subtotal: 2200, tax: 200, total: 2200, rates: [[10, 2200]], account: "会議費", payment: "card",
        invoice: { value: "T1180301018771", status: "registered" }, validation: "ok", entry: { debit: "会議費", amt10: 2200, amt8: 0, amt0: 0 } } },
    { id: "B04", category: "basic", title: "Amazon（領収書、消耗品）",
      text: L("Amazon.co.jp 領収書", "注文日 2026年9月20日", "注文番号 250-0000000-0000000", "USBケーブル ¥1,580", "マウスパッド ¥990", "小計 ¥2,570", "(10%対象 ¥2,570 消費税 ¥233)", "ご請求額 ¥2,570", "クレジットカード ¥2,570"),
      expected: { date: "2026-09-20", merchant: "Amazon", total: 2570, rates: [[10, 2570]], account: "消耗品費", payment: "card",
        entry: { debit: "消耗品費", amt10: 2570, amt8: 0, amt0: 0 } } },
    { id: "B05", category: "basic", title: "Apple（iPad、10万円未満）",
      text: L("Apple テスト店", "2026/09/15 14:05", "iPad Air ¥98,800", "小計 ¥98,800", "(10%対象 ¥98,800 内税 ¥8,981)", "合計 ¥98,800", "クレジット ¥98,800"),
      expected: { date: "2026-09-15", merchant: "Apple", subtotal: 98800, tax: 8981, total: 98800, rates: [[10, 98800]], account: "消耗品費", payment: "card", fixedAsset: false, validation: "ok",
        entry: { debit: "消耗品費", amt10: 98800, amt8: 0, amt0: 0 } } },
    { id: "B06", category: "basic", title: "家電量販店（MacBook ¥250,000 → 固定資産候補）",
      text: L("ヨドバシカメラ テスト店", "2026年9月20日 15:10", "MacBook Pro 14 ¥250,000", "小計 ¥250,000", "(10%対象 ¥250,000 内税 ¥22,727)", "合計 ¥250,000", "クレジット ¥250,000"),
      expected: { date: "2026-09-20", merchant: "ヨドバシカメラ", total: 250000, tax: 22727, rates: [[10, 250000]], fixedAsset: true, payment: "card", validation: "ok",
        entry: { debit: "消耗品費", amt10: 250000, amt8: 0, amt0: 0 } } },
    { id: "B07", category: "basic", title: "タクシー（旅費交通費）",
      text: L("領収書", "テスト交通株式会社", "2026年9月18日 22:41", "乗車料金 ¥2,300", "(10%対象 ¥2,300 消費税 ¥209)", "合計 ¥2,300", "上記正に領収いたしました"),
      expected: { documentType: "receipt", date: "2026-09-18", merchant: "テスト交通", total: 2300, rates: [[10, 2300]], account: "旅費交通費",
        entry: { debit: "旅費交通費", amt10: 2300, amt8: 0, amt0: 0 } } },
    { id: "B08", category: "basic", title: "通信費（携帯の請求書）",
      text: L("請求書", "NTTドコモ", "ご請求金額 ¥8,800", "ご利用期間 2026年8月1日〜8月31日", "発行日 2026年9月10日", "ご利用料金 ¥8,000", "消費税等 ¥800", "合計 ¥8,800", "お支払期限 2026年9月30日"),
      expected: { documentType: "invoice", date: "2026-09-10", merchant: "NTTドコモ", total: 8800, tax: 800, account: "通信費",
        entry: { debit: "通信費", amt10: 8800, amt8: 0, amt0: 0 } } },
    { id: "B09", category: "basic", title: "家賃（住宅家賃は非課税）",
      text: L("領収証", "テスト不動産", "2026年9月1日", "10月分 家賃", "金額 ¥120,000 (非課税)", "合計 ¥120,000", "上記正に領収いたしました"),
      expected: { documentType: "receipt", date: "2026-09-01", total: 120000, rates: [[0, 120000]],
        entry: { debit: "地代家賃", amt10: 0, amt8: 0, amt0: 120000 } } },

    // ---------- tax ----------
    { id: "X01", category: "tax", title: "10%のみ",
      text: L("テスト文具店", "2026/09/10", "ノート ¥550", "(10%対象 ¥550 内税 ¥50)", "合計 ¥550", "現金 ¥550"),
      expected: { date: "2026-09-10", total: 550, tax: 50, rates: [[10, 550]], validation: "ok", entry: { debit: "消耗品費", amt10: 550, amt8: 0, amt0: 0 } } },
    { id: "X02", category: "tax", title: "8%のみ（テイクアウト）",
      text: L("テストベーカリー", "2026/09/11", "※クロワッサン ¥324", "(8%対象 ¥324 内税 ¥24)", "合計 ¥324", "現金 ¥324"),
      expected: { date: "2026-09-11", total: 324, tax: 24, rates: [[8, 324]], validation: "ok", entry: { debit: "消耗品費", amt10: 0, amt8: 324, amt0: 0 } } },
    { id: "X03", category: "tax", title: "8%+10%（税抜表示・消費税等）",
      text: L("テスト食品", "2026/09/12", "外税", "10%対象 ¥5,000", "8%対象 ¥3,000", "小計 ¥8,000", "消費税等 ¥740", "合計 ¥8,740"),
      expected: { date: "2026-09-12", subtotal: 8000, tax: 740, total: 8740, validation: "ok", entry: { debit: "消耗品費", amt10: 5500, amt8: 3240, amt0: 0 } } },
    { id: "X04", category: "tax", title: "非課税（切手）",
      text: L("テスト郵便局", "2026/09/13", "84円切手 10枚 非課税 ¥840", "合計 ¥840"),
      expected: { date: "2026-09-13", total: 840, rates: [[0, 840]], entry: { debit: "通信費", amt10: 0, amt8: 0, amt0: 840 } } },
    { id: "X05", category: "tax", title: "不課税（収入印紙）",
      text: L("テスト郵便局", "2026/09/14", "収入印紙 不課税 ¥200", "合計 ¥200"),
      expected: { date: "2026-09-14", total: 200, rates: [[0, 200]], entry: { debit: "租税公課", amt10: 0, amt8: 0, amt0: 200 } } },
    { id: "X06", category: "tax", title: "免税",
      text: L("TEST DUTY FREE", "2026/09/15", "免税 ¥5,000", "合計 ¥5,000"),
      expected: { date: "2026-09-15", total: 5000, rates: [[0, 5000]], entry: { debit: "消耗品費", amt10: 0, amt8: 0, amt0: 5000 } } },

    // ---------- invoice (registration number) ----------
    { id: "I01", category: "invoice", title: "登録番号あり",
      text: L("テスト商事株式会社", "登録番号 T7000012050002", "2026/09/16", "コピー用紙 ¥1,100", "(10%対象 ¥1,100 内税 ¥100)", "合計 ¥1,100"),
      expected: { date: "2026-09-16", total: 1100, invoice: { value: "T7000012050002", status: "registered" }, validation: "ok", entry: { debit: "消耗品費", amt10: 1100, amt8: 0, amt0: 0 } } },
    { id: "I02", category: "invoice", title: "登録番号なし",
      text: L("テスト屋台", "2026/09/16", "焼きそば ¥800", "合計 ¥800"),
      expected: { date: "2026-09-16", total: 800, invoice: { value: null, status: "not_found" }, entry: { debit: "会議費", amt10: 800, amt8: 0, amt0: 0 } } },
    { id: "I03", category: "invoice", title: "登録番号がかすれている（OCR不確実）",
      text: L("テスト商事株式会社", "登録番号 T70000l2O50002", "2026/09/17", "封筒 ¥550", "(10%対象 ¥550 内税 ¥50)", "合計 ¥550"),
      expected: { date: "2026-09-17", total: 550, invoice: { value: "T7000012050002", status: "uncertain" }, validation: "warning", review: true, entry: { debit: "消耗品費", amt10: 550, amt8: 0, amt0: 0 } } },
    { id: "I04", category: "invoice", title: "複数税率＋登録番号",
      text: L("テスト百貨店", "登録番号 T1180301018771", "2026/09/18", "※菓子 ¥1,080", "タオル ¥2,200", "小計 ¥3,280", "(10%対象 ¥2,200 内税 ¥200)", "(8%対象 ¥1,080 内税 ¥80)", "合計 ¥3,280"),
      expected: { date: "2026-09-18", total: 3280, tax: 280, rates: [[10, 2200], [8, 1080]], invoice: { value: "T1180301018771", status: "registered" }, validation: "ok",
        entry: { debit: "消耗品費", amt10: 2200, amt8: 1080, amt0: 0 } } },

    // ---------- OCR errors (must be corrected with lower confidence, or caught for review) ----------
    { id: "E01", category: "ocr", title: "0とO（合計 11,8OO）",
      text: L("テスト工具店", "2026/09/19", "工具セット ¥11,800", "合計 ¥11,8OO"),
      expected: { date: "2026-09-19", total: 11800, corrected: "total", entry: { debit: "消耗品費", amt10: 11800, amt8: 0, amt0: 0 } } },
    { id: "E02", category: "ocr", title: "1とI（合計 l,500）",
      text: L("テスト書店", "2026/09/19", "参考書 ¥1,500", "合計 ¥l,500"),
      expected: { date: "2026-09-19", total: 1500, corrected: "total", entry: { debit: "新聞図書費", amt10: 1500, amt8: 0, amt0: 0 } } },
    { id: "E03", category: "ocr", title: "8と3（税額 ¥300 → 本当は ¥800）",
      text: L("テスト家具", "2026/09/20", "棚 ¥8,800", "(10%対象 ¥8,800 内税 ¥300)", "合計 ¥8,800"),
      expected: { date: "2026-09-20", total: 8800, validation: "error", review: true, entry: { debit: "消耗品費", amt10: 8800, amt8: 0, amt0: 0 } } },
    { id: "E04", category: "ocr", title: "¥がYに",
      text: L("テスト雑貨", "2026/09/21", "マグカップ Y1,650", "合計 Y1,650"),
      expected: { date: "2026-09-21", total: 1650, entry: { debit: "消耗品費", amt10: 1650, amt8: 0, amt0: 0 } } },
    { id: "E05", category: "ocr", title: "カンマ位置の誤り（合計 1,10）",
      text: L("テスト花店", "2026/09/22", "花束 ¥1,100", "(10%対象 ¥1,100 内税 ¥100)", "合計 ¥1,10"),
      expected: { date: "2026-09-22", review: true, entry: { debit: "消耗品費", amt10: 1100, amt8: 0, amt0: 0 } } },
    { id: "E06", category: "ocr", title: "小数点が千の区切りに（11.800）",
      text: L("テスト電材", "2026/09/23", "ケーブル ¥11,800", "合計 ¥11.800"),
      expected: { date: "2026-09-23", total: 11800, corrected: "total", entry: { debit: "消耗品費", amt10: 11800, amt8: 0, amt0: 0 } } },
    { id: "E07", category: "ocr", title: "税額の誤り（小計+税≠合計）",
      text: L("テスト印刷", "2026/09/24", "外税", "名刺印刷 ¥5,000", "小計 ¥5,000", "消費税等 ¥600", "合計 ¥5,500"),
      expected: { date: "2026-09-24", validation: "error", review: true, entry: { debit: "広告宣伝費", amt10: 5500, amt8: 0, amt0: 0 } } },

    // ---------- document types ----------
    { id: "T01", category: "type", title: "納品書", text: L("納品書", "株式会社テスト資材 御中", "下記の通り納品いたします", "納品日 2026/09/05", "資材A 10個 ¥11,000", "合計 ¥11,000"),
      expected: { documentType: "delivery_note", total: 11000 } },
    { id: "T02", category: "type", title: "クレジットカード明細", text: L("カードご利用代金明細書", "ご利用日 ご利用店名 ご利用金額", "2026/09/01 テスト商店 ¥1,000", "2026/09/03 テスト食堂 ¥2,200", "お支払金額 ¥3,200"),
      expected: { documentType: "credit_card_statement", validation: "error", review: true } },
    { id: "T03", category: "type", title: "通帳", text: L("普通預金通帳", "日付 摘要 お引出し お預入れ 残高", "09-01 振込 ¥50,000 ¥150,000", "09-05 カード ¥10,000 ¥140,000"),
      expected: { documentType: "bank_statement", validation: "error", review: true } },
    { id: "T04", category: "type", title: "契約書", text: L("業務委託契約書", "甲 テスト株式会社 乙 テスト太郎", "第1条 甲は乙に業務を委託する", "第2条 契約期間は2026年10月1日から1年とする", "記名押印の上各1通を保有する"),
      expected: { documentType: "contract" } },
    { id: "T05", category: "type", title: "公共料金（電気）", text: L("電気ご使用量のお知らせ", "ご使用期間 2026/08/01〜08/31", "ご使用量 250kWh", "ご請求金額 ¥8,000", "口座振替日 2026/09/25"),
      expected: { documentType: "bill", total: 8000 } },

    // ---------- duplicate (same receipt as B01, read again) ----------
    { id: "D01", category: "duplicate", title: "同じレシートの再アップロード", duplicateOf: "B01",
      text: L("ローソン テスト駅前店", "東京都千代田区テスト1-1-1", "TEL 03-0000-1111", "登録番号 T7000012050002", "2026年9月28日(月) 08:12", "レシートNo.1234",
        "ボールペン ¥330", "※おにぎり ¥162", "※お茶 ¥140", "小計 ¥632", "(10%対象 ¥330 内税 ¥30)", "(8%対象 ¥302 内税 ¥22)", "合計 ¥632", "お預り ¥1,000", "お釣り ¥368"),
      expected: { date: "2026-09-28", total: 632, duplicate: true } },
  ];

  /** Image-defect cases (generated from invented images in the tests): the warning each must raise. */
  const IMAGE_CASES = [
    { id: "M01", title: "正常スキャン", defect: "scan", expectWarnings: [], expectRetake: false },
    { id: "M02", title: "スマホ撮影（机の上）", defect: "phone", expectWarnings: [], expectRetake: false },
    { id: "M03", title: "回転（90°）", defect: "rotate90", note: "detected by OCR orientation retry, not by the image check" },
    { id: "M04", title: "斜め（6°）", defect: "skew", expectWarnings: ["skew"], expectRetake: false },
    { id: "M05", title: "影", defect: "shadow", expectWarnings: ["shadow"] },
    { id: "M06", title: "反射", defect: "glare", expectWarnings: ["glare"] },
    { id: "M07", title: "ぼけ", defect: "blur", expectWarnings: ["blur"], expectRetake: true },
    { id: "M08", title: "低解像度", defect: "lowres", expectWarnings: ["lowResolution"] },
    { id: "M09", title: "一部切れ", defect: "crop", expectWarnings: ["cropped"] },
    { id: "M10", title: "暗い背景・暗い写真", defect: "dark", expectWarnings: ["dark"], expectRetake: true },
  ];

  const api = { CASES, IMAGE_CASES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DocGolden = api;
})(typeof window !== "undefined" ? window : globalThis);
