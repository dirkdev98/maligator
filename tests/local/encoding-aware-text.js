function equal(actual, expected, name) {
	if (actual !== expected) {
		throw new Error(
			name + ": " + JSON.stringify(actual) + " != " + JSON.stringify(expected),
		);
	}
}

function collect() {
	const gc = globalThis.__mal_collect_garbage;
	if (typeof gc === "function") gc();
}

const latin = String.fromCharCode(0x41, 0, 0x7f, 0x80, 0xe9, 0xff).repeat(12);
const wideParent = "\u0100-prefix:" + latin + ":suffix-\u03a9";
const wideSlice = wideParent.slice(9, -9);
const nestedSlice = ("before" + wideSlice + "after").slice(6, -5);
const parsedLatin = JSON.parse(JSON.stringify(latin));
const variants = [latin, wideSlice, nestedSlice, parsedLatin];
const records = { [latin]: "found" };
const map = new Map([[wideSlice, "mapped"]]);
const set = new Set([latin]);

for (let i = 0; i < variants.length; i++) {
	const value = variants[i];
	equal(value, latin, "equal code units across producers " + i);
	equal(value.length, 72, "UTF-16 length " + i);
	equal(records[value], "found", "object key hash " + i);
	equal(map.get(value), "mapped", "Map key hash " + i);
	equal(set.has(value), true, "Set key hash " + i);
	equal(value.charCodeAt(3), 0x80, "unsigned Latin-1 code unit " + i);
	equal(value.charCodeAt(5), 0xff, "last Latin-1 code unit " + i);
	equal(value.indexOf("\0\x7f\x80"), 1, "search through NUL " + i);
}
equal("\xff" < "\u0100", true, "ordering crosses encoding width");
equal(latin === latin.slice(0, -1) + "\xfe", false, "last code unit differs");
equal(records[latin.slice(0, -1) + "\xfe"], undefined, "different key stays distinct");

const prefix = "x".repeat(64);
const suffix = "y".repeat(64);
const highLeaf = prefix + String.fromCharCode(0xd83d);
const lowLeaf = String.fromCharCode(0xde00) + suffix;
const rope = highLeaf + lowLeaf;
const pair = rope.slice(64, 66);
const loneHigh = rope.slice(64, 65);
const loneLow = rope.slice(65, 66);
equal(rope.length, 130, "rope UTF-16 length");
equal(rope.codePointAt(64), 0x1f600, "code point crosses rope leaves");
equal([...rope].length, 129, "iterator combines rope-leaf surrogate pair");
equal(pair, "\ud83d\ude00", "slice spanning rope leaves");
equal(loneHigh.charCodeAt(0), 0xd83d, "slice retains lone high surrogate");
equal(loneLow.charCodeAt(0), 0xde00, "slice retains lone low surrogate");
equal(rope.indexOf(pair), 64, "search crosses rope leaves");
equal(rope.includes("x" + pair + "y"), true, "mixed-width search crosses leaves");

const retained = ("\u0100" + "a".repeat(16384) + latin + "\u03a9").slice(-73, -1);
collect();
equal(retained, latin, "small slice survives backing-store collection");
equal(wideParent.charCodeAt(0), 0x100, "wide parent remains intact");
equal(wideSlice, latin, "dependent slice survives parent consumers");
console.log("encoding-aware-text strings PASS");

const outputParts = [
	latin,
	"-",
	"\u0100",
	"-",
	pair,
	"-",
	loneHigh,
	"-",
	loneLow,
	"-",
	latin,
];
const expectedOutput = latin + "-\u0100-\ud83d\ude00-\ud83d-\ude00-" + latin;
const joined = outputParts.join("");
equal(joined, expectedOutput, "join promotes after a Latin-1 prefix");
equal(
	(latin + "#" + latin).replace("#", "\u0100"),
	latin + "\u0100" + latin,
	"replacement promotes without losing the prefix",
);
equal(
	(latin + "#" + latin).replace(/#/g, () => {
		collect();
		return pair;
	}),
	latin + pair + latin,
	"replacement output survives callback collection",
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encoded = encoder.encode("\u00e9\u00ff\0\u0100" + pair);
equal(
	Array.from(encoded).join(","),
	"195,169,195,191,0,196,128,240,159,152,128",
	"UTF-8 boundary encodes Latin-1 as Unicode",
);
equal(decoder.decode(encoded), "\u00e9\u00ff\0\u0100\ud83d\ude00", "UTF-8 round trip");
equal(
	Array.from(encoder.encode(loneHigh + "x" + loneLow)).join(","),
	"239,191,189,120,239,191,189",
	"UTF-8 replaces isolated surrogates",
);
equal(
	decoder.decode(encoder.encode(rope)),
	rope,
	"UTF-8 joins surrogate pair across leaves",
);
const pairBoundary = "z".repeat(64) + loneHigh + (loneLow + "!");
for (const capacity of [63, 64, 65, 66, 67, 68, 69]) {
	const destination = new Uint8Array(capacity);
	const result = encoder.encodeInto(pairBoundary, destination);
	const expectedRead =
		capacity < 64 ? capacity : capacity < 68 ? 64 : capacity === 68 ? 66 : 67;
	const expectedWritten = capacity < 68 ? Math.min(capacity, 64) : capacity;
	equal(
		result.read,
		expectedRead,
		"encodeInto atomic surrogate read at capacity " + capacity,
	);
	equal(
		result.written,
		expectedWritten,
		"encodeInto atomic surrogate write at capacity " + capacity,
	);
	equal(
		decoder.decode(destination.subarray(0, result.written)),
		pairBoundary.slice(0, result.read),
		"encodeInto whole-code-point output at capacity " + capacity,
	);
}
for (const capacity of [0, 1, 2, 3, 4]) {
	const result = encoder.encodeInto(loneHigh + "!", new Uint8Array(capacity));
	equal(
		result.read,
		capacity < 3 ? 0 : capacity === 3 ? 1 : 2,
		"encodeInto lone surrogate read " + capacity,
	);
	equal(
		result.written,
		capacity < 3 ? 0 : capacity,
		"encodeInto lone surrogate bytes " + capacity,
	);
}
const nulDestination = new Uint8Array(3);
const nulResult = encoder.encodeInto("\xff\0A", nulDestination);
equal(nulResult.read, 2, "encodeInto NUL counts one code unit");
equal(nulResult.written, 3, "encodeInto NUL writes one byte");
equal(Array.from(nulDestination).join(","), "195,191,0", "encodeInto keeps embedded NUL");
equal(
	Number("\xa0".repeat(48) + "12.5" + "\xa0".repeat(48)),
	12.5,
	"Number trims compact rope whitespace",
);
equal(
	Number("\u2000".repeat(48) + "12.5" + "\u2000".repeat(48)),
	12.5,
	"Number trims wide rope whitespace",
);
equal(Number.isNaN(Number("12\0.5")), true, "Number does not terminate at NUL");
equal(
	JSON.stringify(rope),
	'"' + prefix + pair + suffix + '"',
	"JSON joins pair across leaves",
);
equal(
	JSON.stringify(loneHigh + "x" + loneLow),
	'"\\ud83dx\\ude00"',
	"JSON escapes isolated surrogates",
);
const escapedKey = latin + '"\\\n\0';
const escapedRecord = { [escapedKey]: joined };
const escapedJSON = JSON.stringify(escapedRecord);
equal(
	JSON.parse(escapedJSON)[escapedKey],
	joined,
	"JSON round trip of mixed keys and values",
);
equal(
	JSON.stringify({ latin: "\x80\xe9\xff", nul: "\0", wide: "\u0100" }),
	'{"latin":"\x80\xe9\xff","nul":"\\u0000","wide":"\u0100"}',
	"JSON output keeps code units and promotes at a later value",
);
console.log("encoding-aware-text producers PASS");

const hookOrder = [];
const nested = {};
Object.defineProperty(nested, "value", {
	enumerable: true,
	get() {
		hookOrder.push("getter");
		collect();
		return "\u0100";
	},
});
equal(
	JSON.stringify({ prefix: latin, plain: { a: 1 }, nested }),
	'{"prefix":' + JSON.stringify(latin) + ',"plain":{"a":1},"nested":{"value":"\u0100"}}',
	"nested getter falls back after a plain prefix",
);
equal(hookOrder.join(","), "getter", "fallback does not replay getter");

const nonEnumerableHook = { value: 1 };
Object.defineProperty(nonEnumerableHook, "toJSON", {
	value(key) {
		hookOrder.push("own:" + key);
		return "own";
	},
});
const inheritedHook = Object.create({
	toJSON(key) {
		hookOrder.push("inherited:" + key);
		return "inherited";
	},
});
inheritedHook.value = 2;
equal(
	JSON.stringify({ prefix: 1, own: nonEnumerableHook, inherited: inheritedHook }),
	'{"prefix":1,"own":"own","inherited":"inherited"}',
	"non-enumerable and inherited toJSON are observable",
);
equal(
	hookOrder.join(","),
	"getter,own:own,inherited:inherited",
	"toJSON runs exactly once",
);

const proxyOrder = [];
const proxy = new Proxy(
	{ value: "\xff" },
	{
		ownKeys(target) {
			proxyOrder.push("keys");
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			proxyOrder.push("descriptor:" + key);
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		get(target, key, receiver) {
			proxyOrder.push("get:" + key);
			return Reflect.get(target, key, receiver);
		},
	},
);
equal(
	JSON.stringify({ prefix: { a: "plain" }, proxy }),
	'{"prefix":{"a":"plain"},"proxy":{"value":"\xff"}}',
	"nested proxy falls back after a plain prefix",
);
equal(
	proxyOrder.join(","),
	"get:toJSON,keys,descriptor:value,get:value",
	"fallback does not replay proxy traps",
);

const replacerOrder = [];
equal(
	JSON.stringify(
		{ first: undefined, keep: latin, drop: "\u0100", end: "\xff" },
		function (key, value) {
			replacerOrder.push(key);
			if (key === "drop") {
				collect();
				return undefined;
			}
			return value;
		},
	),
	'{"keep":' + JSON.stringify(latin) + ',"end":"\xff"}',
	"omission rolls back member separators and partial output",
);
equal(
	replacerOrder.join(","),
	",first,keep,drop,end",
	"replacer visits omitted members in order",
);
equal(
	JSON.stringify([undefined, () => {}, Symbol("omit")]),
	"[null,null,null]",
	"array omission becomes null",
);

let deep = "leaf";
const depth = 1200;
for (let i = 0; i < depth; i++) deep = { next: deep };
equal(
	JSON.stringify(deep),
	'{"next":'.repeat(depth) + '"leaf"' + "}".repeat(depth),
	"deep plain-object serialization uses iterative traversal",
);
const shared = { value: "\xe9" };
equal(
	JSON.stringify([shared, shared]),
	'[{"value":"\xe9"},{"value":"\xe9"}]',
	"shared children are not cycles",
);
const cyclic = { prefix: "\xff" };
cyclic.self = cyclic;
let cycleThrew = false;
try {
	JSON.stringify(cyclic);
} catch (error) {
	cycleThrew = error instanceof TypeError;
}
equal(cycleThrew, true, "plain-data cycles throw TypeError");
equal(
	JSON.stringify({ after: "\u0100" }),
	'{"after":"\u0100"}',
	"serialization recovers after cycle",
);
console.log("encoding-aware-text JSON PASS");
