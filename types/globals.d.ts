// Globals shared between the browser modules (each module registers itself on window when not under Node).
interface Window {
  Books: any; Filing: any; ReceiptOCR: any; Imports: any; Migrate: any; Journal: any; LedgerService: any;
  Tesseract: any; pdfjsLib: any; heic2any: any; gapi: any; google: any;
}
declare var module: { exports: any } | undefined;
