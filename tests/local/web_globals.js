// WinterTC "Minimum Common API" acceptance fixture. Exercises
// the self-contained globals installed by mal_web_globals_install + the interval
// timers. Runs on the host entry (event loop drives the async checks). Prints one
// line per check and a final "RESULT <passed>/<total>" line the runner asserts.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}
function isDOMException(error, name, code) {
	return (
		error instanceof DOMException &&
		error instanceof Error &&
		error.name === name &&
		error.code === code
	);
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

// --- TextDecoder fatal / ignoreBOM options ---
const decDefault = new TextDecoder("utf-8");
check("TextDecoder default fatal getter", decDefault.fatal === false);
check("TextDecoder default ignoreBOM getter", decDefault.ignoreBOM === false);

const decFatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
check("TextDecoder fatal getter true", decFatal.fatal === true);
check("TextDecoder ignoreBOM getter true", decFatal.ignoreBOM === true);

// The getters have no setter; assignment must not mutate the option.
try {
	decFatal.fatal = false;
} catch (e) {}
try {
	decFatal.ignoreBOM = false;
} catch (e) {}
check("TextDecoder fatal getter readonly", decFatal.fatal === true);
check("TextDecoder ignoreBOM getter readonly", decFatal.ignoreBOM === true);

let fatalInvalidThrew = false;
try {
	decFatal.decode(new Uint8Array([0xff]));
} catch (e) {
	fatalInvalidThrew = e instanceof TypeError;
}
check("TextDecoder fatal rejects invalid byte 0xFF", fatalInvalidThrew);

let fatalTruncatedThrew = false;
try {
	// 3-byte lead with a single continuation byte -> truncated sequence.
	decFatal.decode(new Uint8Array([0xe2, 0x82]));
} catch (e) {
	fatalTruncatedThrew = e instanceof TypeError;
}
check("TextDecoder fatal rejects truncated sequence", fatalTruncatedThrew);

check(
	"TextDecoder fatal accepts valid utf-8",
	decFatal.decode(new Uint8Array([104, 105])) === "hi",
);
check(
	"TextDecoder lenient replaces invalid byte",
	decDefault.decode(new Uint8Array([0xff])) === "\uFFFD",
);
check(
	"TextDecoder lenient replaces truncated sequence",
	decDefault.decode(new Uint8Array([0xe2, 0x82])) === "\uFFFD",
);

const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 104, 105]);
const decIgnoreBom = new TextDecoder("utf-8", { ignoreBOM: true });
check(
	"TextDecoder ignoreBOM preserves U+FEFF",
	decIgnoreBom.decode(bomBytes) === "\uFEFFhi",
);
check("TextDecoder default strips U+FEFF", decDefault.decode(bomBytes) === "hi");

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
	btoaThrew = isDOMException(e, "InvalidCharacterError", 5);
}
check("btoa rejects >0xFF with InvalidCharacterError", btoaThrew);
let atobThrew = false;
try {
	atob("not*base64");
} catch (e) {
	atobThrew = isDOMException(e, "InvalidCharacterError", 5);
}
check("atob rejects invalid character with InvalidCharacterError", atobThrew);
let atobLengthThrew = false;
try {
	atob("a");
} catch (e) {
	atobLengthThrew = isDOMException(e, "InvalidCharacterError", 5);
}
check("atob rejects invalid length with InvalidCharacterError", atobLengthThrew);
let atobPaddingThrew = false;
try {
	atob("Zg=");
} catch (e) {
	atobPaddingThrew = isDOMException(e, "InvalidCharacterError", 5);
}
check("atob rejects partial padding with InvalidCharacterError", atobPaddingThrew);
let base64MissingArgsAreTypeErrors = false;
try {
	btoa();
} catch (btoaError) {
	try {
		atob();
	} catch (atobError) {
		base64MissingArgsAreTypeErrors =
			btoaError instanceof TypeError && atobError instanceof TypeError;
	}
}
check("btoa/atob missing arguments remain TypeError", base64MissingArgsAreTypeErrors);
const base64Abrupt = new Error("base64 coercion");
let base64AbruptPreserved = false;
try {
	btoa({
		toString() {
			throw base64Abrupt;
		},
	});
} catch (e) {
	base64AbruptPreserved = e === base64Abrupt;
}
check("btoa preserves coercion abrupt completion", base64AbruptPreserved);

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
const maxRnd = new Uint8Array(65536);
check("getRandomValues accepts 65536 bytes", crypto.getRandomValues(maxRnd) === maxRnd);
let grvThrew = false;
try {
	crypto.getRandomValues(new Float64Array(4));
} catch (e) {
	grvThrew = isDOMException(e, "TypeMismatchError", 17);
}
check("getRandomValues rejects float with TypeMismatchError", grvThrew);
let grvDataViewThrew = false;
try {
	crypto.getRandomValues(new DataView(new ArrayBuffer(4)));
} catch (e) {
	grvDataViewThrew = isDOMException(e, "TypeMismatchError", 17);
}
check("getRandomValues rejects DataView with TypeMismatchError", grvDataViewThrew);
let grvValueThrew = false;
try {
	crypto.getRandomValues(1);
} catch (e) {
	grvValueThrew = isDOMException(e, "TypeMismatchError", 17);
}
check("getRandomValues rejects non-view value with TypeMismatchError", grvValueThrew);
let grvTooLargeThrew = false;
try {
	crypto.getRandomValues(new Uint8Array(65537));
} catch (e) {
	grvTooLargeThrew = isDOMException(e, "QuotaExceededError", 22);
}
check(
	"getRandomValues rejects more than 65536 bytes with QuotaExceededError",
	grvTooLargeThrew,
);
let grvMissingThrew = false;
try {
	crypto.getRandomValues();
} catch (e) {
	grvMissingThrew = e instanceof TypeError;
}
check("getRandomValues missing argument remains TypeError", grvMissingThrew);

// --- console UTF-8 stdout sentinel ---
// builtin_console must emit accented BMP (é), euro (€), and a supplementary
// emoji (😀, a surrogate pair) as valid UTF-8 rather than \u escapes.
console.log("SENTINEL é€😀");

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
