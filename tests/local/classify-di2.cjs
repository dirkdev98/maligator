const fs = require("fs");
const j = require("/Users/dirk/projects/maligator/scripts/test262.json");
const base = "/Users/dirk/projects/maligator/.cache/test262/";
const arr = [];
for (const [p, v] of Object.entries(j.results))
	if (v === "FAILED" && p.startsWith("test/language/expressions/dynamic-import/"))
		arr.push(p);

const buckets = {};
const add = (k, p) => {
	(buckets[k] ??= []).push(p);
};
for (const p of arr) {
	let src = "";
	try {
		src = fs.readFileSync(base + p, "utf8");
	} catch (e) {}
	const fm = (src.match(/\/\*---([\s\S]*?)---\*\//) || [])[1] || "";
	const feat = (fm.match(/features:\s*\[([^\]]*)\]/) || [])[1] || "";
	const features = feat
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const hasDefer = features.includes("import-defer") || /import\.defer/.test(src);
	const hasSource =
		features.includes("source-phase-imports") || /import\.source/.test(src);
	const hasAttrs =
		features.includes("import-attributes") ||
		/\bwith\s*\{/.test(src) ||
		/assert\s*:/.test(src);
	let k;
	if (hasSource) k = "source-phase";
	else if (hasDefer) k = "import-defer";
	else if (hasAttrs) k = "import-attributes";
	else if (p.includes("/catch/")) k = "catch(error-path)";
	else if (p.includes("/namespace/")) k = "namespace";
	else if (p.includes("/assignment-expression/"))
		k = "assignment-expr(computed-specifier)";
	else if (p.includes("/usage/")) k = "usage";
	else if (p.includes("/syntax/")) k = "syntax";
	else k = "root/other";
	add(k, p);
}
const keys = Object.keys(buckets).sort((a, b) => buckets[b].length - buckets[a].length);
for (const k of keys) console.log(String(buckets[k].length).padStart(4), k);
console.log("TOTAL", arr.length);
console.log("\n--- catch(error-path) samples ---");
for (const p of (buckets["catch(error-path)"] || []).slice(0, 20))
	console.log("  ", p.split("/").pop());
console.log("\n--- namespace samples ---");
for (const p of (buckets["namespace"] || []).slice(0, 20))
	console.log("  ", p.split("/").pop());
console.log("\n--- root/other samples ---");
for (const p of buckets["root/other"] || []) console.log("  ", p.split("/").pop());
console.log("\n--- usage samples ---");
for (const p of buckets["usage"] || []) console.log("  ", p.split("/").pop());
