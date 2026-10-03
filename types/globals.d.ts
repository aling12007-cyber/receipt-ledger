// Globals shared between the browser modules (each module registers itself on window when not under Node).
interface Window {
  Books: any; Filing: any; Accounts: any; TaxRules: any; crypto: Crypto; ReceiptOCR: any; Imports: any; Migrate: any; Journal: any; LedgerService: any; Sync: any; Ledger: any; Tips: any; DocModel: any; DocQuality: any; DocPreprocess: any; DocProviders: any; DocPipeline: any; DocDigits: any; DocClassify: any; DocExtract: any; DocValidate: any; DocConfidence: any; DocReverify: any; DocMerchant: any; DocDuplicate: any; DocTransaction: any; DocGolden: any; DocEvaluate: any; IncomeTax: any; ConsumptionTax: any; TaxCalendar: any; TaxGuide: any;
  Tesseract: any; pdfjsLib: any; heic2any: any; gapi: any; google: any;
}
declare var module: { exports: any } | undefined;
declare function require(path: string): any;
// Journal entry shape shared by engine/journal.js, engine/ledger-service.js and the screens.
interface JournalLine { account: string; dr: number; cr: number; tax_code: string; tax_amount: number; memo?: string }
interface JournalEntry { id?: string; date: string; kind: string; vendor: string; invoice_no: string; memo: string; lines: JournalLine[]; reverses?: string | null; invoice_status?: string | null; rule_version?: string }
