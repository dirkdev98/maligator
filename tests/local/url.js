// WHATWG URL / URLSearchParams acceptance fixture (isolate_todo.md, task #17).
// Exercises the ada-url-backed URL class + the pure-C URLSearchParams. Runs on the
// host entry; prints one line per check and a final "RESULT <passed>/<total>" the
// runner asserts. Written before the implementation (TDD) to pin exact behavior.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}
function eq(name, got, want) {
	check(name + " (got " + JSON.stringify(got) + ")", got === want);
}

// --- URL parsing + getters ---
const u = new URL("https://user:pass@example.com:8080/p/q?x=1&y=2#frag");
eq("href", u.href, "https://user:pass@example.com:8080/p/q?x=1&y=2#frag");
eq("protocol", u.protocol, "https:");
eq("username", u.username, "user");
eq("password", u.password, "pass");
eq("host", u.host, "example.com:8080");
eq("hostname", u.hostname, "example.com");
eq("port", u.port, "8080");
eq("pathname", u.pathname, "/p/q");
eq("search", u.search, "?x=1&y=2");
eq("hash", u.hash, "#frag");
eq("origin", u.origin, "https://example.com:8080");
eq("toString", u.toString(), u.href);
eq("toJSON", u.toJSON(), u.href);
eq("String()", String(u), u.href);

// Default port is dropped.
eq("default-port-dropped", new URL("https://example.com:443/a").port, "");
eq("default-port-href", new URL("https://example.com:443/a").href, "https://example.com/a");

// --- relative resolution via base ---
eq("base-absolute-path", new URL("/a/b", "https://example.com/x/y").href, "https://example.com/a/b");
eq("base-relative-path", new URL("q", "https://example.com/dir/").href, "https://example.com/dir/q");
eq("base-dotdot", new URL("../z", "https://example.com/a/b/c").href, "https://example.com/a/z");

// --- invalid URL throws TypeError ---
let threw = false;
try {
	new URL("not a valid url");
} catch (e) {
	threw = e instanceof TypeError;
}
check("invalid throws TypeError", threw);

// --- URL.canParse ---
check("canParse valid", URL.canParse("https://example.com") === true);
check("canParse invalid", URL.canParse("http://") === false);
check("canParse with base", URL.canParse("/p", "https://example.com") === true);

// --- setters reflect in href ---
const s = new URL("https://example.com/a");
s.protocol = "http:";
s.hostname = "other.example";
s.port = "90";
s.pathname = "/z";
s.search = "?k=v";
s.hash = "#h";
eq("setter-protocol", s.protocol, "http:");
eq("setter-hostname", s.hostname, "other.example");
eq("setter-port", s.port, "90");
eq("setter-pathname", s.pathname, "/z");
eq("setter-search", s.search, "?k=v");
eq("setter-hash", s.hash, "#h");
eq("setter-href", s.href, "http://other.example:90/z?k=v#h");

// --- URLSearchParams: parse + read ---
const p = new URLSearchParams("a=1&b=2&a=3");
eq("usp-get-first", p.get("a"), "1");
check("usp-getAll", JSON.stringify(p.getAll("a")) === JSON.stringify(["1", "3"]));
check("usp-has", p.has("b") === true && p.has("z") === false);
eq("usp-toString", p.toString(), "a=1&b=2&a=3");

// leading '?' is stripped
eq("usp-leading-q", new URLSearchParams("?x=1").get("x"), "1");

// percent + plus decoding
const dec = new URLSearchParams("x=a%20b&y=%26&z=a+b");
eq("usp-decode-pct", dec.get("x"), "a b");
eq("usp-decode-amp", dec.get("y"), "&");
eq("usp-decode-plus", dec.get("z"), "a b");

// --- URLSearchParams: mutation ---
const m = new URLSearchParams("a=1&b=2&a=3");
m.append("c", "4");
eq("usp-append", m.toString(), "a=1&b=2&a=3&c=4");
m.set("a", "9"); // replaces first, removes the rest
eq("usp-set", m.toString(), "a=9&b=2&c=4");
m.delete("b");
eq("usp-delete", m.toString(), "a=9&c=4");

// --- URLSearchParams: encoding on serialize (form-urlencoded) ---
const enc = new URLSearchParams();
enc.set("m", "a b&c=d");
eq("usp-encode", enc.toString(), "m=a+b%26c%3Dd");

// --- URLSearchParams from object ---
eq("usp-from-object", new URLSearchParams({ p: "1", q: "2" }).toString(), "p=1&q=2");

// --- URLSearchParams sort (stable by key) ---
const so = new URLSearchParams("c=1&a=2&b=3&a=0");
so.sort();
eq("usp-sort", so.toString(), "a=2&a=0&b=3&c=1");

// --- URLSearchParams iteration ---
let iterated = "";
for (const [k, v] of new URLSearchParams("a=1&b=2")) {
	iterated += k + "=" + v + ";";
}
eq("usp-iterate", iterated, "a=1;b=2;");

let keys = "";
for (const k of new URLSearchParams("a=1&b=2").keys()) keys += k;
eq("usp-keys", keys, "ab");

let forEachOut = "";
new URLSearchParams("a=1&b=2").forEach((v, k) => {
	forEachOut += k + ":" + v + ";";
});
eq("usp-forEach", forEachOut, "a:1;b:2;");

// --- url.searchParams (snapshot read for v1) ---
eq("url-searchParams-get", new URL("https://x.com/?a=1&b=2").searchParams.get("a"), "1");
eq("url-searchParams-toString", new URL("https://x.com/?a=1&b=2").searchParams.toString(), "a=1&b=2");

// --- summary ---
let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
