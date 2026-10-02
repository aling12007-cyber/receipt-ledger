// Load the browser modules (UMD style: they set module.exports when `module` exists) into Node tests,
// in this realm so deepStrictEqual works on what they return. Modules may require() each other by relative path.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const cache = new Map();

export function load(file) {
  const abs = path.resolve(root, file);
  if (cache.has(abs)) return cache.get(abs);
  const code = fs.readFileSync(abs, "utf8");
  const module = { exports: {} };
  const require = (p) => load(path.relative(root, path.resolve(path.dirname(abs), p)));
  vm.runInThisContext(`(function (module, exports, require) {${code}\n})`, { filename: abs })(module, module.exports, require);
  cache.set(abs, module.exports);
  return module.exports;
}
