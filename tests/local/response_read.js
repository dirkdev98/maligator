// Response synchronous getters + construction (STRESS-safe; the async read methods
// text/json/arrayBuffer/bytes are covered by the fetch server's /respread route).
//   node scripts/webtest.ts tests/local/response_read.js

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const r = new Response("hi", {
	status: 201,
	statusText: "Created",
	headers: { "content-type": "text/plain" },
});
check("status", r.status === 201);
check("ok", r.ok === true);
check("statusText", r.statusText === "Created");
check("headers is Headers", r.headers instanceof Headers);
check("headers.get", r.headers.get("content-type") === "text/plain");

const r2 = new Response("x", { status: 404, statusText: "Not Found" });
check("not-ok", r2.ok === false);
check("status 404", r2.status === 404);
check("statusText 404", r2.statusText === "Not Found");

const rDefault = new Response("y");
check("default status 200", rDefault.status === 200 && rDefault.ok === true);

// Binary body construction (BufferSource).
const rb = new Response(new Uint8Array([1, 2, 3]));
check("binary-ctor status", rb.status === 200);

// Static Response.json / redirect / error.
const rj = Response.json({ ok: true, n: 5 });
check("Response.json status", rj.status === 200);
check(
	"Response.json content-type",
	rj.headers.get("content-type") === "application/json",
);
const rjCustom = Response.json(
	{ a: 1 },
	{ status: 201, headers: { "content-type": "application/problem+json" } },
);
check(
	"Response.json keeps custom CT",
	rjCustom.headers.get("content-type") === "application/problem+json" &&
		rjCustom.status === 201,
);

const rd = Response.redirect("https://example.com/x", 301);
check(
	"Response.redirect",
	rd.status === 301 && rd.headers.get("location") === "https://example.com/x",
);

const re = Response.error();
check("Response.error", re.status === 0);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
