let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function concatenate(left, right) {
	return left + right;
}

function tinySlice(source, start, end) {
	return source.slice(start, end);
}

const values = [
	tinySlice("xry", 1, 2),
	concatenate("a", "b"),
	concatenate("a", "bc"),
	concatenate("ab", "cd"),
	concatenate("ab", "cde"),
];
ok("lengths one through five", values.join("|") === "r|ab|abc|abcd|abcde");

const nul = concatenate("\0", "x");
const latin1 = concatenate("\u00ff", "x");
const bmp = concatenate("\u2603", "x");
const high = concatenate("\ud83d", "x");
const low = concatenate("\ude00", "x");
const pair = concatenate("\ud83d", "\ude00");
ok("embedded NUL", nul.length === 2 && nul.charCodeAt(0) === 0);
ok("Latin-1 code unit", latin1 === "\u00ffx");
ok("BMP code unit", bmp === "\u2603x");
ok("lone high surrogate", high.charCodeAt(0) === 0xd83d && high.length === 2);
ok("lone low surrogate", low.charCodeAt(0) === 0xde00 && low.length === 2);
ok("split surrogate pair", pair.length === 2 && [...pair][0] === "\ud83d\ude00");

// "1a" and "zb" share the low eight bits of the runtime's content hash. Force
// replacement, then atomize a fresh "1a" so the cache must promote the older
// canonical property atom back into that slot.
const canonical1a = concatenate("1", "a");
const keyed = { [canonical1a]: 40 };
const collidingZb = concatenate("z", "b");
ok("collision value", collidingZb === "zb");
const fresh1a = concatenate("1", "a");
if (typeof $262 !== "undefined") $262.gc();
ok("collision never aliases content", fresh1a === "1a" && fresh1a !== collidingZb);
keyed[fresh1a] += 2;
ok("atom promotion preserves property", keyed["1a"] === 42);

const computed = {};
for (let i = 0; i < 4000; i++) {
	const key = i % 2 === 0 ? concatenate("be", "ta") : concatenate("a", "b");
	computed[key] = (computed[key] ?? 0) + 1;
}
ok("repeated computed properties", computed.beta === 2000 && computed.ab === 2000);

const numericConcat = concatenate("1", "2");
const numericAscii = String(12);
const primitiveMap = new Map([[numericConcat, 12]]);
ok("equal primitive constructors", numericConcat === numericAscii);
ok("Map content equality", primitiveMap.get(numericAscii) === 12);

let numericChecksum = 0;
for (let i = 0; i < 4096; i++) {
	const value = i & 1023;
	const text = String(value);
	if (Number(text) !== value) throw new Error("broken cached uint string");
	numericChecksum += text.length + text.charCodeAt(0);
}
ok("cached uint conversion checksum", numericChecksum === 228628);
ok(
	"uint cache boundaries",
	String(0) === "0" &&
		String(255) === "255" &&
		String(1023) === "1023" &&
		String(1024) === "1024" &&
		String(-1) === "-1" &&
		String(-2147483648) === "-2147483648" &&
		String(2147483647) === "2147483647" &&
		String(-0) === "0",
);

const numericKeys = {};
numericKeys[String(0)] = "zero";
numericKeys[String(255)] = "byte";
numericKeys[String(1023)] = "cached";
numericKeys[String(1024)] = "outside";
ok(
	"cached uint property keys",
	numericKeys[0] === "zero" &&
		numericKeys[255] === "byte" &&
		numericKeys[1023] === "cached" &&
		numericKeys[1024] === "outside",
);

const boxedA = Object(concatenate("a", "b"));
const boxedB = Object(concatenate("a", "b"));
ok(
	"boxed strings remain distinct",
	boxedA !== boxedB && boxedA.valueOf() === boxedB.valueOf(),
);

const indices = {};
for (const key of ["0", "01", "-0", "4294967294", "4294967295"]) indices[key] = key;
ok(
	"array-index boundaries",
	indices[0] === "0" &&
		indices["01"] === "01" &&
		indices["-0"] === "-0" &&
		indices[4294967294] === "4294967294" &&
		indices[4294967295] === "4294967295",
);

const symbolA = Symbol(concatenate("a", "b"));
const symbolB = Symbol(concatenate("a", "b"));
ok("symbols remain distinct", symbolA !== symbolB);

if (typeof $262 !== "undefined") {
	const other = $262.createRealm().global;
	const otherKey = other.eval(`(function (a, b) { return a + b; })("be", "ta")`);
	ok(
		"cross-Realm primitive key",
		keyed[otherKey] === undefined && computed[otherKey] === 2000,
	);
	ok("cross-Realm uint string", other.eval("String(1023)") === String(1023));
	$262.gc();
}

ok("post-GC canonical lookup", keyed[concatenate("1", "a")] === 42);
console.log(`tiny-string-cache PASS ${passed}/${passed}`);
