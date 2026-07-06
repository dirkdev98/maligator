// Request constructor synchronous surface (STRESS-safe). The async body round-trip
// is covered by the fetch server's /reqctor route.
//   node scripts/webtest.ts tests/local/request_ctor.js
// v1 keeps the method as-given (no spec uppercasing) — asserted accordingly.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const r = new Request("https://example.com/p", {
	method: "PUT",
	headers: { "x-a": "1" },
});
check("url", r.url === "https://example.com/p");
check("method", r.method === "PUT");
check("headers is Headers", r.headers instanceof Headers);
check("headers.get", r.headers.get("x-a") === "1");
check("default method GET", new Request("u").method === "GET");
check("default url", new Request("http://h/x").url === "http://h/x");

// Copy from an existing Request.
const r2 = new Request(r);
check("copy url", r2.url === "https://example.com/p");
check("copy method", r2.method === "PUT");
check("copy headers", r2.headers.get("x-a") === "1");

// init overrides a copied Request's method.
const r3 = new Request(r, { method: "DELETE" });
check("override method", r3.method === "DELETE" && r3.url === "https://example.com/p");

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
