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

const r2 = new Request(r);
check("copy url", r2.url === "https://example.com/p");
check("copy method", r2.method === "PUT");
check("copy headers", r2.headers.get("x-a") === "1");

const r3 = new Request(r, { method: "DELETE" });
check("override method", r3.method === "DELETE" && r3.url === "https://example.com/p");

check("default signal", r.signal instanceof AbortSignal && !r.signal.aborted);
check("signal identity is stable", r.signal === r.signal);
const controller = new AbortController();
const controlled = new Request("https://example.com/controlled", {
	signal: controller.signal,
});
const copied = new Request(controlled);
const cloned = controlled.clone();
check(
	"requests own distinct signals",
	controlled.signal !== controller.signal &&
		copied.signal !== controlled.signal &&
		cloned.signal !== controlled.signal,
);
let aborts = 0;
controlled.signal.addEventListener("abort", () => aborts++);
const reason = { message: "cancelled" };
controller.abort(reason);
controller.abort("ignored");
check(
	"request signals follow their source",
	controlled.signal.aborted && controlled.signal.reason === reason && aborts === 1,
);
check(
	"copies and clones follow aborts",
	copied.signal.aborted &&
		cloned.signal.aborted &&
		copied.signal.reason === reason &&
		cloned.signal.reason === reason,
);
check(
	"already aborted signals are copied",
	new Request(controlled).signal.reason === reason,
);
check(
	"null removes an inherited signal",
	!new Request(controlled, { signal: null }).signal.aborted,
);
const replacement = new AbortController();
const overridden = new Request(controlled, { signal: replacement.signal });
check("init overrides an inherited signal", !overridden.signal.aborted);
replacement.abort("replacement");
check(
	"overridden signals follow the replacement",
	overridden.signal.reason === "replacement",
);
for (const signal of [false, "signal", {}]) {
	let rejected = false;
	try {
		new Request("https://example.com/invalid", { signal });
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check("invalid signal types are rejected", rejected);
}

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
