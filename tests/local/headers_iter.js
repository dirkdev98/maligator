// Headers iteration acceptance fixture. Run via:
//   node scripts/webtest.ts tests/local/headers_iter.js
// v1 yields pairs in insertion order, stored case, uncombined (spec sort/lowercase/
// combine is a follow-up), so the expectations below match that behavior.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const h = new Headers();
h.append("a", "1");
h.append("b", "2");
h.append("a", "3");

let e = "";
for (const [k, v] of h.entries()) e += k + "=" + v + ";";
check("entries", e === "a=1;b=2;a=3;");

let e2 = "";
for (const [k, v] of h) e2 += k + "=" + v + ";";
check("default @@iterator === entries", e2 === "a=1;b=2;a=3;");

let ks = "";
for (const k of h.keys()) ks += k + ",";
check("keys", ks === "a,b,a,");

let vs = "";
for (const v of h.values()) vs += v + ",";
check("values", vs === "1,2,3,");

let fe = "";
h.forEach((v, k) => {
	fe += k + ":" + v + ";";
});
check("forEach (value, key)", fe === "a:1;b:2;a:3;");

// spread + Array.from over the iterator
check("spread", [...h.keys()].length === 3);
check("Array.from entries", Array.from(h).length === 3);

// from a plain-object init
const h2 = new Headers({ "x-one": "u", "x-two": "w" });
let ho = "";
for (const [k, v] of h2) ho += k + "=" + v + ";";
check("init-from-object iterates", ho.includes("x-one=u") && ho.includes("x-two=w"));

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
