// Load the browser modules (UMD style: they set module.exports when `module` exists) into Node tests,
// in this realm so deepStrictEqual works on what they return.
import fs from "node:fs";
import vm from "node:vm";

export function load(file) {
  const code = fs.readFileSync(new URL("../../" + file, import.meta.url), "utf8");
  const module = { exports: {} };
  vm.runInThisContext(`(function (module, exports) {${code}\n})`, { filename: file })(module, module.exports);
  return module.exports;
}
