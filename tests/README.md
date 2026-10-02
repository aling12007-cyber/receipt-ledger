# Tests

Run `npm test` (Node 18+, no install needed).

- `golden/cases.js` — 30 Golden Test Cases for a Japanese sole proprietor (tax year 2026). They are the
  specification for the Journal, Ledger, Tax and Closing engines: each case lists the posted journal entries
  (account, debit, credit, 税区分, tax amount) and the figures that must follow (trial balance, 決算書,
  consumption tax, checks).
- `golden.test.js` — checks every case is consistent, runs today's code (`books.js`, `filing.js`) on the
  cases it can express, and reports the rest as `todo` with what is missing.
- `ocr.test.js` — receipt text parsing on invented receipts.

The repository is public: never add real receipts, OCR output of real receipts, names or card numbers.
