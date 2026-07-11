const fs = require("fs");
const j = require("/Users/dirk/projects/maligator/scripts/test262.json");
const base = "/Users/dirk/projects/maligator/.cache/test262/";
const arr = [];
for (const [p, v] of Object.entries(j.results))
  if (v === "FAILED" && p.startsWith("test/language/expressions/dynamic-import/")) arr.push(p);

const cat = { literal: [], identifier: [], template: [], computed: [], negativeParse: [], other: [], noImportCall: [] };
for (const p of arr) {
  let src = "";
  try { src = fs.readFileSync(base + p, "utf8"); } catch (e) { cat.other.push(p); continue; }
  const fm = (src.match(/\/\*---([\s\S]*?)---\*\//) || [])[1] || "";
  const neg = /\n\s*negative:/.test(fm) || /^negative:/.test(fm);
  if (neg) { cat.negativeParse.push(p); continue; }
  // strip import.meta / import.source etc; find bare import( calls
  const m = [...src.matchAll(/import(?:\.source|\.defer)?\s*\(\s*([^\n]*)/g)];
  if (m.length === 0) { cat.noImportCall.push(p); continue; }
  let kind = "other";
  for (const mm of m) {
    const a = mm[1].trim();
    if (/^["']/.test(a) || a[0] === "`") { kind = "literal"; break; }
    if (/^[A-Za-z_$][\w$]*\s*[,)]/.test(a)) { if (kind === "other") kind = "identifier"; }
    else { if (kind === "other") kind = "computed"; }
  }
  cat[kind === "other" ? "computed" : kind].push(p);
}
for (const k of Object.keys(cat)) console.log(k, cat[k].length);
console.log("--- sample identifier ---");
for (const p of cat.identifier.slice(0, 8)) console.log(" ", p);
console.log("--- sample computed ---");
for (const p of cat.computed.slice(0, 12)) console.log(" ", p);
console.log("--- sample noImportCall ---");
for (const p of cat.noImportCall.slice(0, 8)) console.log(" ", p);
console.log("--- sample negativeParse ---");
for (const p of cat.negativeParse.slice(0, 8)) console.log(" ", p);
