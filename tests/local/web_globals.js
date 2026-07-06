// WinterTC "Minimum Common API" acceptance fixture (isolate_todo.md). Exercises
// the self-contained globals installed by mal_web_globals_install + the interval
// timers. Runs on the host entry (event loop drives the async checks). Prints one
// line per check and a final "RESULT <passed>/<total>" line the runner asserts.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}
function bytes(u8) {
	// Index manually rather than Array.from(u8): the latter trips a pre-existing
	// GC-rooting bug in Array.from over a typed array under MAL_GC_STRESS, which is
	// unrelated to the WinterTC surface under test here.
	let s = "";
	for (let i = 0; i < u8.length; i++) {
		s += (i > 0 ? "," : "") + u8[i];
	}
	return s;
}

// --- TextEncoder ---
const enc = new TextEncoder();
check("TextEncoder.encoding", enc.encoding === "utf-8");
check("TextEncoder instanceof", enc instanceof TextEncoder);
const encoded = enc.encode("héllo€");
// h=104, é=C3 A9, l l o, €=E2 82 AC
check(
	"TextEncoder.encode utf-8",
	bytes(encoded) === "104,195,169,108,108,111,226,130,172",
);
check("TextEncoder.encode is Uint8Array", encoded instanceof Uint8Array);
check(
	"TextEncoder.encode empty",
	bytes(enc.encode("")) === "" && enc.encode("").length === 0,
);

// encodeInto: exact fit and truncated fit (never splits a code point)
const dest = new Uint8Array(10);
const r1 = enc.encodeInto("ab€", dest);
check("encodeInto read/written", r1.read === 3 && r1.written === 5);
check("encodeInto bytes", dest[0] === 97 && dest[1] === 98 && dest[2] === 226);
const small = new Uint8Array(2);
const r2 = enc.encodeInto("a€", small); // "€" is 3 bytes, won't fit after "a"
check("encodeInto no split", r2.read === 1 && r2.written === 1 && small[0] === 97);

// --- TextDecoder ---
const dec = new TextDecoder();
check("TextDecoder.encoding", dec.encoding === "utf-8");
check("TextDecoder round-trip", dec.decode(encoded) === "héllo€");
check("TextDecoder empty", dec.decode() === "" && dec.decode(new Uint8Array(0)) === "");
check(
	"TextDecoder from ArrayBuffer",
	dec.decode(new Uint8Array([104, 105]).buffer) === "hi",
);
check(
	"TextDecoder BOM stripped",
	dec.decode(new Uint8Array([0xef, 0xbb, 0xbf, 104, 105])) === "hi",
);
check("TextDecoder utf-8 alias", new TextDecoder("UTF-8").encoding === "utf-8");
let decThrew = false;
try {
	new TextDecoder("latin1");
} catch (e) {
	decThrew = e instanceof RangeError;
}
check("TextDecoder rejects non-utf8", decThrew);

// --- btoa / atob ---
check("btoa", btoa("hello") === "aGVsbG8=");
check("btoa padding", btoa("foobar") === "Zm9vYmFy" && btoa("fo") === "Zm8=");
check("atob", atob("aGVsbG8=") === "hello");
check(
	"btoa/atob round-trip",
	atob(btoa("The quick brown fox")) === "The quick brown fox",
);
check("atob whitespace tolerant", atob("aGVs bG8=") === "hello");
let btoaThrew = false;
try {
	btoa("snowman:☃");
} catch (e) {
	btoaThrew = true;
}
check("btoa rejects >0xFF", btoaThrew);
let atobThrew = false;
try {
	atob("not*base64");
} catch (e) {
	atobThrew = true;
}
check("atob rejects invalid", atobThrew);

// --- performance ---
check("performance.now type", typeof performance.now() === "number");
const p1 = performance.now();
const p2 = performance.now();
check("performance.now monotonic", p2 >= p1);
check(
	"performance.timeOrigin",
	typeof performance.timeOrigin === "number" && performance.timeOrigin > 0,
);

// --- crypto ---
const uuid = crypto.randomUUID();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
check("crypto.randomUUID format", uuidRe.test(uuid));
check("crypto.randomUUID unique", crypto.randomUUID() !== crypto.randomUUID());
const rnd = new Uint8Array(16);
const rndRet = crypto.getRandomValues(rnd);
check("getRandomValues returns arg", rndRet === rnd);
let anyNonZero = false;
for (let i = 0; i < rnd.length; i++) {
	if (rnd[i] !== 0) anyNonZero = true;
}
check("getRandomValues fills", anyNonZero);
let grvThrew = false;
try {
	crypto.getRandomValues(new Float64Array(4));
} catch (e) {
	grvThrew = true;
}
check("getRandomValues rejects float", grvThrew);

// --- queueMicrotask ordering (runs after sync, before timers) ---
let order = "";
queueMicrotask(() => {
	order += "m";
});
order += "s";
setTimeout(() => {
	order += "t";
});

// --- setInterval / clearInterval ---
let ticks = 0;
let intervalId = setInterval(() => {
	ticks++;
	if (ticks >= 3) {
		clearInterval(intervalId);
	}
}, 5);

// Finalize after the interval has had time to run and clear itself.
setTimeout(() => {
	check("queueMicrotask before timer", order === "smt");
	check("setInterval ticked 3x then stopped", ticks === 3);

	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) passed++;
		else console.log("FAIL: " + name);
	}
	console.log("RESULT " + passed + "/" + results.length);
}, 60);
