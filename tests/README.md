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

## All checks

`npm run check` runs, in order (each must pass before the next):

1. `verify:build` — `scripts/build.mjs`: every file index.html references exists, every inline script and module parses,
   the manifest is valid, and every translation key used exists in en / ja / zh.
2. `lint` — ESLint (`eslint.config.js`) on the modules, the API, the tests and the inline app script.
3. `typecheck` — TypeScript in checkJs mode (`tsconfig.json`) on the browser modules.
4. `test` — the Node test suite.

ESLint and TypeScript are taken from PATH (the npm registry is not reachable from every build machine).
