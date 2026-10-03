// Lint rules: the bug-catching core of eslint:recommended, written out because the recommended preset
// package is not installed in this environment. Run with `npm run lint` (uses the eslint on PATH).
const browser = Object.fromEntries(["window", "document", "navigator", "location", "history", "localStorage", "sessionStorage", "fetch", "URL", "URLSearchParams",
  "Blob", "File", "FileReader", "Image", "HTMLCanvasElement", "OffscreenCanvas", "createImageBitmap", "crypto", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "atob", "btoa", "TextEncoder", "TextDecoder", "Event", "CustomEvent", "MutationObserver", "IntersectionObserver", "matchMedia", "alert", "confirm",
  "getComputedStyle", "structuredClone", "queueMicrotask", "performance", "AbortController", "Response", "Request", "Headers", "FormData", "globalThis", "self"].map((g) => [g, "readonly"]));
const node = Object.fromEntries(["process", "Buffer", "module", "require", "__dirname", "console", "URL", "fetch", "setTimeout", "clearTimeout", "globalThis", "TextEncoder", "TextDecoder", "crypto", "structuredClone"].map((g) => [g, "readonly"]));
// globals the page gets from its other <script> tags
const pageLibs = Object.fromEntries(["supabase", "Tesseract", "ReceiptOCR", "Filing", "Books", "Imports", "Migrate", "Journal", "LedgerService", "Sync", "Accounts", "TaxRules", "Ledger", "Tips", "DocModel", "DocQuality", "DocPreprocess", "DocProviders", "DocPipeline", "DocDigits", "DocClassify", "DocExtract", "DocValidate", "DocConfidence", "DocReverify", "DocMerchant", "DocDuplicate", "DocTransaction", "pdfjsLib", "heic2any", "google", "gapi"].map((g) => [g, "readonly"]));

const rules = {
  "no-undef": "error", "no-dupe-keys": "error", "no-dupe-args": "error", "no-duplicate-case": "error", "no-unreachable": "error",
  "no-redeclare": "error", "no-const-assign": "error", "no-func-assign": "error", "no-self-assign": "error", "no-unsafe-finally": "error",
  "no-unsafe-negation": "error", "valid-typeof": "error", "use-isnan": "error", "no-sparse-arrays": "error", "no-dupe-else-if": "error",
  "no-import-assign": "error", "no-obj-calls": "error", "no-invalid-regexp": "error", "no-loss-of-precision": "error", "no-setter-return": "error",
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  "no-cond-assign": ["error", "except-parens"], "no-constant-condition": ["error", { checkLoops: false }],
  "no-empty-pattern": "error", "no-fallthrough": "error", "no-global-assign": "error", "no-shadow-restricted-names": "error", "no-with": "error",
};

export default [
  { ignores: ["node_modules/**", "pdfjs/**", ".vercel/**"] },
  { files: ["books.js", "filing.js", "ocr.js", "imports.js", "tips.js", "engine/**/*.js", "document-intelligence/**/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...browser, module: "readonly" } }, rules },
  { files: [".check/index.inline.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...browser, ...pageLibs } }, rules: { ...rules, "no-unused-vars": ["error", { args: "none", caughtErrors: "none", vars: "local", varsIgnorePattern: "^_" }] } },
  { files: ["api/**/*.js", "tests/**/*.js", "scripts/**/*.mjs", "supabase/tests/**/*.mjs", "eslint.config.js"], languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: node }, rules },
];
