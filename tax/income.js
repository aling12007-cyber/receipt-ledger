// Receipt Ledger — income tax, resident tax and business tax for a sole proprietor (estimates for the return guide).
// Rules are versioned by tax year; every rule names its source. Not a substitute for the NTA's own calculation:
// the 確定申告書等作成コーナー computes the final figures — this module tells the user what to type and what to expect.
// Exposes window.IncomeTax (and module.exports for tests).
(function (root) {
  const NTA_KISO_2026 = "https://www.nta.go.jp/publication/pamph/gensen/2026kaisei.pdf";
  const NTA_KISO_2025 = "https://www.nta.go.jp/users/gensen/2025kiso/index.htm";
  const NTA_RATES = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm";

  /** Income tax brackets (速算表): [upper bound of taxable income, rate, deduction]. Unchanged since 2015. */
  const BRACKETS = [[1950000, 0.05, 0], [3300000, 0.1, 97500], [6950000, 0.2, 427500], [9000000, 0.23, 636000], [18000000, 0.33, 1536000], [40000000, 0.4, 2796000], [Infinity, 0.45, 4796000]];

  /** 基礎控除 by 合計所得金額: [upper bound, amount]. */
  const BASIC = {
    2024: [[24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]],
    // 令和7年分: 58万円 + 特例 (132万以下 95万 / 336万以下 88万 / 489万以下 68万 / 655万以下 63万)
    2025: [[1320000, 950000], [3360000, 880000], [4890000, 680000], [6550000, 630000], [23500000, 580000], [24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]],
    // 令和8・9年分: 62万円 + 特例 (489万以下 +42万 / 655万以下 +5万)
    2026: [[4890000, 1040000], [6550000, 670000], [23500000, 620000], [24000000, 480000], [24500000, 320000], [25000000, 160000], [Infinity, 0]],
  };
  BASIC[2027] = BASIC[2026];
  const SOURCES = [
    { rule: "BASIC 2026–2027", url: NTA_KISO_2026, checked: "2026-10-03" },
    { rule: "BASIC 2025", url: NTA_KISO_2025, checked: "2026-10-03" },
    { rule: "BRACKETS", url: NTA_RATES, checked: "2026-10-03" },
  ];
  const basicTable = (year) => BASIC[year] || BASIC[Math.max(...Object.keys(BASIC).map(Number).filter((y) => y <= year))] || BASIC[2026];
  /** @param {number} totalIncome 合計所得金額 @param {number} year */
  const basicDeduction = (totalIncome, year) => basicTable(year).find(([up]) => totalIncome <= up)[1];

  const floor = (v, unit) => Math.floor(Math.max(0, v) / unit) * unit;

  /** 生命保険料控除 (new contracts, per category: general / care & medical / pension), income tax. @param {number} paid */
  function lifeInsurance(paid) {
    const p = Math.max(0, paid || 0);
    if (p <= 20000) return p;
    if (p <= 40000) return Math.floor(p / 2 + 10000);
    if (p <= 80000) return Math.floor(p / 4 + 20000);
    return 40000;
  }
  /** Same for resident tax (max 28,000 per category). @param {number} paid */
  function lifeInsuranceResident(paid) {
    const p = Math.max(0, paid || 0);
    if (p <= 12000) return p;
    if (p <= 32000) return Math.floor(p / 2 + 6000);
    if (p <= 56000) return Math.floor(p / 4 + 14000);
    return 28000;
  }

  /**
   * @typedef {{ year: number, businessIncome: number, blueDeduction: number, salaryIncome?: number, otherIncome?: number,
   *   socialInsurance?: number, smallBizMutual?: number, lifeGeneral?: number, lifeCare?: number, lifePension?: number, earthquake?: number,
   *   medicalPaid?: number, medicalReimbursed?: number, donations?: number, spouse?: boolean, dependents?: number, specialDependents?: number,
   *   withheld?: number, prepaid?: number, businessTaxRate?: number, lossCarried?: number, blue?: boolean }} ReturnInput
   *   businessIncome: 事業所得 before 青色申告特別控除 (売上 − 経費 − 減価償却)
   *   donations: ふるさと納税 etc. (寄附金) · withheld: 源泉徴収税額 (報酬から引かれた分 + 給与) · prepaid: 予定納税額
   *   lossCarried: 前年以前3年内の純損失の繰越額（青色申告）
   */

  /** All figures of one year's return (estimate). @param {ReturnInput} x */
  function compute(x) {
    const y = x.year;
    // a business loss is set off against other income (損益通算); the blue deduction never creates or enlarges a loss
    const bi = x.businessIncome || 0;
    const business = bi > 0 ? Math.max(0, bi - (x.blueDeduction || 0)) : bi;
    const combined = business + Math.max(0, x.salaryIncome || 0) + Math.max(0, x.otherIncome || 0);
    const total = Math.max(0, combined);                                              // 合計所得金額
    // 純損失: what is left after setting off; with blue it can be carried forward 3 years (翌年以後に繰越)
    const lossThisYear = combined < 0 && (x.blue ?? (x.blueDeduction || 0) > 0) ? -combined : 0;
    const lossCarried = Math.max(0, x.lossCarried || 0), lossUsed = Math.min(lossCarried, total);
    const afterLoss = total - lossUsed;                                               // 総所得金額等 (after 純損失の繰越控除)
    // 所得控除
    const d = {};
    d.socialInsurance = Math.max(0, x.socialInsurance || 0);
    d.smallBizMutual = Math.max(0, x.smallBizMutual || 0);
    d.life = Math.min(120000, lifeInsurance(x.lifeGeneral) + lifeInsurance(x.lifeCare) + lifeInsurance(x.lifePension));
    d.earthquake = Math.min(50000, Math.max(0, x.earthquake || 0));
    d.medical = Math.min(2000000, Math.max(0, (x.medicalPaid || 0) - (x.medicalReimbursed || 0) - Math.min(100000, afterLoss * 0.05)));
    d.donation = Math.max(0, Math.min(x.donations || 0, afterLoss * 0.4) - 2000);
    d.spouse = x.spouse && total <= 9000000 ? 380000 : 0;      // 配偶者控除 (配偶者の合計所得 58万円以下), 本人900万円以下の額
    d.dependents = (x.dependents || 0) * 380000 + (x.specialDependents || 0) * 630000;
    d.basic = basicDeduction(total, y);
    const deductions = Object.values(d).reduce((s, v) => s + v, 0);
    const taxable = floor(afterLoss - deductions, 1000);                                   // 課税される所得金額 (千円未満切捨て)
    const [, rate, minus] = BRACKETS.find(([up]) => taxable <= up);
    const incomeTax = Math.max(0, Math.floor(taxable * rate - minus));                // 基準所得税額
    const reconstruction = Math.floor(incomeTax * 0.021);                              // 復興特別所得税 (2037年まで)
    const totalTax = incomeTax + reconstruction;
    const payable = totalTax - (x.withheld || 0) - (x.prepaid || 0);                  // 申告納税額 (100円未満切捨て、還付は1円単位)
    const due = payable >= 0 ? floor(payable, 100) : payable;

    // 住民税 (概算): 所得割 10% (控除は住民税の額: 基礎43万・配偶者/扶養33万・生命保険最大7万・地震2.5万), 調整控除 2,500円, 均等割 5,000円
    const rd = d.socialInsurance + d.smallBizMutual + d.medical + Math.min(70000, lifeInsuranceResident(x.lifeGeneral) + lifeInsuranceResident(x.lifeCare) + lifeInsuranceResident(x.lifePension))
      + Math.min(25000, Math.floor(Math.max(0, x.earthquake || 0) / 2)) + (x.spouse ? 330000 : 0) + (x.dependents || 0) * 330000 + (x.specialDependents || 0) * 450000 + (total <= 25000000 ? 430000 : 0);
    const residentBase = floor(afterLoss - rd, 1000);
    const residentIncomePart = Math.max(0, Math.floor(residentBase * 0.1) - (residentBase > 0 ? 2500 : 0));
    // ふるさと納税: 2,000円を除いた額が所得税（寄附金控除）と住民税（基本分・特例分）から差し引かれる。特例分の上限 = 所得割 × 20%
    const furusatoLimit = residentIncomePart > 0 ? Math.floor((residentIncomePart * 0.2) / (0.9 - rate * 1.021) + 2000) : 0;
    const donationResident = Math.max(0, Math.min(x.donations || 0, afterLoss * 0.3) - 2000);
    const residentCredit = Math.min(Math.floor(donationResident * 0.1) + Math.min(Math.floor(donationResident * (0.9 - rate * 1.021)), Math.floor(residentIncomePart * 0.2)), residentIncomePart);
    const residentTax = residentBase > 0 || total > 450000 ? Math.max(0, residentIncomePart - residentCredit) + 5000 : 0;

    // 個人事業税 (概算): (事業所得 青色申告特別控除前 − 事業主控除290万円) × 税率 (多くの業種 5%、業種により 3%・4%・対象外)
    const bizRate = x.businessTaxRate ?? 0.05;
    const businessTax = floor(floor(bi - 2900000, 1000) * bizRate, 100);

    return {
      year: y, totalIncome: total, afterLoss, lossThisYear, lossUsed, lossLeft: lossCarried - lossUsed, businessIncomeAfterBlue: business, deductions: d, deductionTotal: deductions, taxableIncome: taxable,
      rate, incomeTax, reconstruction, totalTax, withheld: x.withheld || 0, prepaid: x.prepaid || 0, due,
      refund: due < 0 ? -due : 0, residentTax, businessTax, furusatoLimit,
      prepayNextYear: totalTax - (x.withheld || 0) >= 150000,   // 予定納税の対象 (予定納税基準額 15万円以上)
    };
  }

  const api = { BRACKETS, BASIC, SOURCES, basicDeduction, lifeInsurance, lifeInsuranceResident, compute };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IncomeTax = api;
})(typeof window !== "undefined" ? window : globalThis);
