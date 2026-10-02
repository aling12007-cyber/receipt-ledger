// Builds an upgrade payload from the Golden cases' legacy rows, for the import test on a local Postgres.
import { CASES } from "../../tests/golden/cases.js";
import { load } from "../../tests/helpers/load.js";
import { randomUUID } from "node:crypto";
const Books = load("books.js"), Filing = load("filing.js"), Migrate = load("engine/migrate.js");
const entries = [], assets = [];
for (const c of CASES.filter((c) => c.legacy && !["28", "29"].includes(c.id))) {   // 28/29 repeat case 30's data
  c.legacy.entries.forEach((e, i) => entries.push({ ...e, id: `c${c.id}-${i}` }));
  for (const a of c.legacy.assets || []) if (!assets.some((x) => x.id === a.id)) assets.push(a);
}
const settings = { assets, filing: "blue65", ctax: "general", bs: { 2026: { open: { cash: 100000, bank: 500000 } } } };
const payload = Migrate.plan(entries, settings, { Books, Filing, uuid: randomUUID });
const v = Migrate.verify(entries, payload, { Books });
if (!v.ok) throw new Error("verify failed " + JSON.stringify(v.diffs));
// expected trial balance (all entries, incl. opening and asset acquisition)
const tb = {};
for (const e of payload.entries) for (const l of e.lines) tb[l.account] = (tb[l.account] || 0) + l.dr - l.cr;
process.stdout.write(JSON.stringify({ payload, tb, count: payload.entries.length }));
