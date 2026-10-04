// "Build" check for a no-bundler static site: everything index.html references exists, every inline script
// and module parses, the manifest is valid JSON, and every translation key used exists in all three languages.
// Writes the inline app script to .check/index.inline.js so lint and type-check can read it.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const rel = (p) => path.join(root, p);
const errors = [];
const html = fs.readFileSync(rel("index.html"), "utf8");

// 1) local files referenced by src/href
for (const m of html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)) {
  const p = m[1] === "/" ? "/index.html" : m[1];
  if (!fs.existsSync(rel(p))) errors.push(`index.html references missing file ${p}`);
}

// 2) inline scripts parse
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!inline.length) errors.push("no inline app script found");
inline.forEach((code, i) => { try { new vm.Script(code, { filename: `index.html#script${i}` }); } catch (e) { errors.push(`index.html inline script ${i}: ${e.message}`); } });
fs.mkdirSync(rel(".check"), { recursive: true });
fs.writeFileSync(rel(".check/index.inline.js"), inline.join("\n;\n"));

// 3) modules parse (browser UMD files as scripts, ES modules via node --check semantics)
const files = ["books.js", "filing.js", "ocr.js", "imports.js", "tips.js", "sw.js", "i18n.js", ...["engine", "document-intelligence", "tax"].flatMap((d) => fs.readdirSync(rel(d)).filter((f) => f.endsWith(".js")).map((f) => d + "/" + f))];
for (const f of files) { try { new vm.Script(fs.readFileSync(rel(f), "utf8"), { filename: f }); } catch (e) { errors.push(`${f}: ${e.message}`); } }

// 4) manifest
try { JSON.parse(fs.readFileSync(rel("manifest.webmanifest"), "utf8")); } catch (e) { errors.push("manifest.webmanifest: " + e.message); }

// 5) translations: every t("key") / data-i18n="key" exists in en, ja and zh
const app = inline.join("\n");
const i18nSrc = fs.readFileSync(rel("i18n.js"), "utf8");
if (!/window\.I18N=/.test(i18nSrc) || !/const I18N=window\.I18N/.test(app)) errors.push("I18N dictionary not found (i18n.js / index.html)");
else {
  const sandbox = { window: {} };
  vm.runInNewContext(i18nSrc, sandbox);
  const I18N = sandbox.window.I18N;
  const used = new Set([...app.matchAll(/\bt\("([A-Za-z0-9_]+)"\s*[,)]/g)].map((m) => m[1]).concat([...html.matchAll(/data-i18n(?:-ph)?="([A-Za-z0-9_]+)"/g)].map((m) => m[1])));
  for (const k of used) for (const lang of ["en", "ja", "zh"]) if (!(k in I18N[lang])) errors.push(`translation "${k}" missing in ${lang}`);
  for (const k of Object.keys(I18N.en)) for (const lang of ["ja", "zh"]) if (!(k in I18N[lang])) errors.push(`translation "${k}" (en) missing in ${lang}`);
}

if (errors.length) { console.error("build: FAILED\n  " + errors.join("\n  ")); process.exit(1); }
console.log(`build: OK (${files.length} modules, ${inline.length} inline script, references and translations complete)`);
