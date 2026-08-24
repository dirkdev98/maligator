const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throwsRangeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof RangeError;
	}
	return false;
}

check(
	"repeat rejects impossible length",
	throwsRangeError(() => "ab".repeat(1e9)),
);
check(
	"repeat measures UTF-16 code units",
	throwsRangeError(() => "\ud83d\ude00".repeat(1e9)),
);
check(
	"padStart rejects impossible length",
	throwsRangeError(() => "x".padStart(1e9, "0")),
);
check(
	"padEnd rejects impossible length",
	throwsRangeError(() => "x".padEnd(1e9, "0")),
);
check(
	"padding repeats and truncates UTF-16 patterns",
	"x".padStart(8, "ab") === "abababax" &&
		"x".padEnd(8, "ab") === "xabababa" &&
		"x".padStart(4, "\ud83d\ude00") === "\ud83d\ude00\ud83dx",
);
const gcPad = String.prototype.padEnd.call(
	{ toString: () => "r".repeat(128) },
	{
		valueOf() {
			if (typeof $262 !== "undefined") $262.gc();
			return 1024;
		},
	},
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "pq".repeat(64);
		},
	},
);
check(
	"padding roots coerced receiver and fill strings",
	gcPad.length === 1024 &&
		gcPad.slice(0, 128) === "r".repeat(128) &&
		gcPad.slice(-4) === "pqpq",
);

function forceGc() {
	if (typeof $262 !== "undefined") $262.gc();
}

function gcNumber(value) {
	return {
		valueOf() {
			forceGc();
			return value;
		},
	};
}

function indexedReceiver() {
	return {
		toString() {
			return ["A", "\ud83d\ude00", "B", "x".repeat(96)].join("");
		},
	};
}

check(
	"character access roots object-coerced receivers across position coercion",
	String.prototype.codePointAt.call(indexedReceiver(), gcNumber(1)) === 0x1f600 &&
		String.prototype.charAt.call(indexedReceiver(), gcNumber(1)) === "\ud83d" &&
		String.prototype.charCodeAt.call(indexedReceiver(), gcNumber(1)) === 0xd83d &&
		String.prototype.at.call(indexedReceiver(), gcNumber(3)) === "B",
);

const primitiveIndexed = "A\ud83d\ude00B";
check(
	"primitive character access preserves numeric index edge cases",
	primitiveIndexed.charAt(undefined) === "A" &&
		primitiveIndexed.charCodeAt(-0) === 0x41 &&
		primitiveIndexed.codePointAt(1) === 0x1f600 &&
		primitiveIndexed.at(-1) === "B" &&
		primitiveIndexed.at(Infinity) === undefined &&
		Number.isNaN(primitiveIndexed.charCodeAt(Infinity)),
);

let tinyStringResultsStayCorrect = true;
for (let i = 0; i < 128; i++) {
	if (
		"abcdef".slice(1, 4) !== "bcd" ||
		String.fromCharCode(97, 98, 99) !== "abc" ||
		"ax".replace("a", "b") !== "bx"
	) {
		tinyStringResultsStayCorrect = false;
	}
	if ((i & 15) === 0) forceGc();
}
check(
	"tiny string representations survive reuse and collection",
	tinyStringResultsStayCorrect,
);

function searchReceiver() {
	return {
		toString() {
			return ["xx-", "needle", "needle", "-yy", "z".repeat(64)].join("");
		},
	};
}

function gcSearch() {
	return {
		toString() {
			forceGc();
			return ["nee", "dle"].join("");
		},
	};
}

check(
	"search methods root receiver and search strings across later positions",
	String.prototype.indexOf.call(searchReceiver(), gcSearch(), gcNumber(1)) === 3 &&
		String.prototype.lastIndexOf.call(searchReceiver(), gcSearch(), gcNumber(15)) === 9 &&
		String.prototype.includes.call(searchReceiver(), gcSearch(), gcNumber(4)) &&
		String.prototype.startsWith.call(searchReceiver(), gcSearch(), gcNumber(3)) &&
		String.prototype.endsWith.call(searchReceiver(), gcSearch(), gcNumber(15)),
);
check(
	"primitive search methods preserve position edge cases",
	"alpha-beta-beta".indexOf("beta", -Infinity) === 6 &&
		"alpha-beta-beta".lastIndexOf("beta", undefined) === 11 &&
		"alpha-beta-beta".includes("beta", NaN) &&
		"alpha-beta-beta".startsWith("alpha", undefined) &&
		"alpha-beta-beta".endsWith("beta", undefined) &&
		!"alpha-beta-beta".endsWith("alpha", NaN),
);

const consSearchSubject = "x".repeat(64) + "needle" + "y".repeat(64);
check(
	"search and scan methods preserve lazy concatenation behavior",
	consSearchSubject.slice(62, 66) === "xxne" &&
		consSearchSubject.indexOf("needle") === 64 &&
		consSearchSubject.includes("needle") &&
		consSearchSubject.trim() === consSearchSubject &&
		consSearchSubject.isWellFormed(),
);
const repeatedRope = "ab".repeat(32768) + "c";
const equalRepeatedRope = "ab".repeat(32768) + "c";
const greaterRepeatedRope = "ab".repeat(32768) + "d";
const differentlyPartitionedRope = "abab".repeat(16384) + "c";
check(
	"equality and comparison preserve shared and differently partitioned ropes",
	repeatedRope === equalRepeatedRope &&
		repeatedRope === differentlyPartitionedRope &&
		repeatedRope < greaterRepeatedRope &&
		greaterRepeatedRope > equalRepeatedRope &&
		!(repeatedRope < equalRepeatedRope),
);
const searchCoercionOrder = [];
const orderedSearch = {
	get [Symbol.match]() {
		searchCoercionOrder.push("isRegExp");
		forceGc();
		return false;
	},
	toString() {
		searchCoercionOrder.push("searchString");
		return ["nee", "dle"].join("");
	},
};
const orderedIncludes = String.prototype.includes.call(
	{
		toString() {
			searchCoercionOrder.push("receiverString");
			return ["xx-", "needle", "-yy", "z".repeat(64)].join("");
		},
	},
	orderedSearch,
);
const receiverThrow = {};
let rejectedSearchReads = 0;
let receiverThrowObserved = false;
try {
	String.prototype.startsWith.call(
		{
			toString() {
				throw receiverThrow;
			},
		},
		{
			get [Symbol.match]() {
				rejectedSearchReads++;
				return false;
			},
		},
	);
} catch (error) {
	receiverThrowObserved = error === receiverThrow;
}
check(
	"search guards coerce receiver before IsRegExp and stop on receiver throws",
	orderedIncludes &&
		searchCoercionOrder.join(",") === "receiverString,isRegExp,searchString" &&
		receiverThrowObserved &&
		rejectedSearchReads === 0,
);

function rangeReceiver() {
	return {
		toString() {
			return ["0123456789", "q".repeat(96)].join("");
		},
	};
}

check(
	"range methods root object-coerced receivers across both bounds",
	String.prototype.slice.call(rangeReceiver(), gcNumber(2), gcNumber(5)) === "234" &&
		String.prototype.substring.call(rangeReceiver(), gcNumber(5), gcNumber(2)) ===
			"234" &&
		String.prototype.substr.call(rangeReceiver(), gcNumber(2), gcNumber(3)) === "234",
);

check(
	"repeat, normalize, and split root receivers across argument coercion",
	String.prototype.repeat.call({ toString: () => ["ab", "cd"].join("") }, gcNumber(3)) ===
		"abcdabcdabcd" &&
		String.prototype.normalize.call(
			{ toString: () => ["norm", "al"].join("") },
			{
				toString() {
					forceGc();
					return ["N", "FC"].join("");
				},
			},
		) === "normal" &&
		String.prototype.split
			.call(
				{ toString: () => ["a,b", ",c"].join("") },
				{
					toString() {
						forceGc();
						return [","].join("");
					},
				},
				gcNumber(3),
			)
			.join("|") === "a|b|c",
);

check(
	"localeCompare roots both coerced strings through collation setup",
	String.prototype.localeCompare.call(
		{ toString: () => ["equal-", "l".repeat(96)].join("") },
		{
			toString() {
				forceGc();
				return ["equal-", "l".repeat(96)].join("");
			},
		},
	) === 0,
);

function flatWorkReceiver(prefix, suffix) {
	return {
		toString() {
			return prefix.repeat(64) + suffix.repeat(64);
		},
	};
}

check(
	"trim and well-formed scans root receivers through flattening and slicing",
	String.prototype.trim.call(flatWorkReceiver(" ", "t")) === "t".repeat(64) &&
		String.prototype.trimStart.call(flatWorkReceiver(" ", "s")) === "s".repeat(64) &&
		String.prototype.trimEnd.call(flatWorkReceiver("e", " ")) === "e".repeat(64) &&
		String.prototype.isWellFormed.call(flatWorkReceiver("i", "s")),
);

check(
	"case conversion and iteration root object-coerced receivers",
	String.prototype.toUpperCase.call(flatWorkReceiver("a", "b")) ===
		"A".repeat(64) + "B".repeat(64) &&
		String.prototype.toLowerCase.call(flatWorkReceiver("A", "B")) ===
			"a".repeat(64) + "b".repeat(64) &&
		String.prototype[Symbol.iterator]
			.call({ toString: () => ["i".repeat(64), "t"].join("") })
			.next().value === "i",
);

const flagsProbe = {
	[Symbol.match]: true,
	get flags() {
		return {
			toString() {
				forceGc();
				return "x".repeat(64) + "g";
			},
		};
	},
	[Symbol.matchAll](subject) {
		return [subject][Symbol.iterator]();
	},
	[Symbol.replace]() {
		return "custom-flags-replace";
	},
};
check(
	"regexp global checks root getter-produced flags through flattening",
	[...String.prototype.matchAll.call("flags-subject", flagsProbe)][0] ===
		"flags-subject" &&
		String.prototype.replaceAll.call("flags-subject", flagsProbe, "unused") ===
			"custom-flags-replace",
);

const fallbackMatch = String.prototype.match.call(
	{ toString: () => ["aaa", "bbb", "ccc"].join("") },
	{
		toString() {
			forceGc();
			return ["b", "+"].join("");
		},
	},
);
const fallbackMatchAll = [
	...String.prototype.matchAll.call(
		{ toString: () => ["a", "b", "b"].join("") },
		{
			toString() {
				forceGc();
				return ["b"].join("");
			},
		},
	),
];
check(
	"fallback regexp protocols root receiver, pattern, and created regexp",
	fallbackMatch[0] === "bbb" &&
		String.prototype.search.call(
			{ toString: () => ["aaa", "bbb", "ccc"].join("") },
			{
				toString() {
					forceGc();
					return ["b", "+"].join("");
				},
			},
		) === 3 &&
		fallbackMatchAll.length === 2 &&
		fallbackMatchAll[0][0] === "b" &&
		fallbackMatchAll[1][0] === "b",
);

// Build exact-limit values once so producers that add their own delimiters can
// exercise the catchable boundary without attempting an impossible allocation.
const halfLimit = "x".repeat(1 << 23);
const atLimit = halfLimit + halfLimit;
check("exact string limit remains valid", atLimit.length === 1 << 24);
check(
	"concat rejects one code unit past the limit",
	throwsRangeError(() => atLimit + "x"),
);
const maxSplit = atLimit.split(atLimit, 0xffffffff);
check(
	"split accepts maximum source, separator, and uint32 limit",
	maxSplit.length === 2 && maxSplit[0] === "" && maxSplit[1] === "",
);
check(
	"Array join rejects delimiter overflow",
	throwsRangeError(() => [halfLimit, halfLimit].join()),
);
let separatorOverflowReads = 0;
const separatorOverflow = [];
Object.defineProperty(separatorOverflow, 0, {
	get() {
		separatorOverflowReads++;
		return "x";
	},
});
separatorOverflow.length = 3;
check(
	"Array join rejects separator overflow before element reads",
	throwsRangeError(() => separatorOverflow.join(atLimit)) && separatorOverflowReads === 0,
);
const localeHalf = { toLocaleString: () => halfLimit };
check(
	"Array toLocaleString rejects delimiter overflow",
	throwsRangeError(() => [localeHalf, localeHalf].toLocaleString()),
);
const gcJoin = [
	{ toString: () => "a".repeat(1024) },
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "b";
		},
	},
].join("");
check("Array join roots earlier coerced strings", gcJoin === "a".repeat(1024) + "b");
const gcLocale = [
	{ toLocaleString: () => "c".repeat(1024) },
	{
		toLocaleString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "d";
		},
	},
].toLocaleString();
check("Array toLocaleString roots earlier results", gcLocale === "c".repeat(1024) + ",d");
check(
	"Error toString rejects framing overflow",
	throwsRangeError(() => Error.prototype.toString.call({ name: atLimit, message: "x" })),
);
const stackError = new Error();
stackError.name = atLimit;
stackError.message = "";
check(
	"Error stack append rejects framing overflow",
	throwsRangeError(() => stackError.stack),
);
function namedAtLimit() {}
Object.defineProperty(namedAtLimit, "name", { value: atLimit, configurable: true });
check(
	"bound function name rejects framing overflow",
	throwsRangeError(() => namedAtLimit.bind(null)),
);
check(
	"computed symbol function name rejects framing overflow",
	throwsRangeError(() => ({ [Symbol(atLimit)]() {} })),
);
check(
	"Object toStringTag rejects framing overflow",
	throwsRangeError(() =>
		Object.prototype.toString.call({ [Symbol.toStringTag]: atLimit }),
	),
);
check(
	"Symbol toString rejects framing overflow",
	throwsRangeError(() => Symbol(atLimit).toString()),
);
check(
	"typed-array join rejects separator overflow",
	throwsRangeError(() => new Uint8Array(2).join(atLimit)),
);
let jsonGetterCalls = 0;
const jsonValue = {};
Object.defineProperty(jsonValue, "first", {
	enumerable: true,
	get() {
		jsonGetterCalls++;
		return atLimit;
	},
});
Object.defineProperty(jsonValue, "second", {
	enumerable: true,
	get() {
		jsonGetterCalls++;
		return 1;
	},
});
check(
	"JSON stringify rejects quoted overflow without continuing getters",
	throwsRangeError(() => JSON.stringify(jsonValue)) && jsonGetterCalls === 1,
);

let execCalls = 0;
const captureBomb = /x/g;
captureBomb.exec = function () {
	if (execCalls++ !== 0) return null;
	return { 0: "x", index: 0, length: 1e9, groups: undefined };
};
check(
	"regexp replacement rejects impossible capture arguments",
	throwsRangeError(() => captureBomb[Symbol.replace]("x", "$1")),
);

check(
	"encodeURIComponent rejects expansion past the limit",
	throwsRangeError(() => encodeURIComponent("%".repeat(1 << 23))),
);
check(
	"btoa rejects expansion past the limit",
	throwsRangeError(() => btoa(atLimit)),
);
check(
	"typed-array hex rejects expansion past the limit",
	throwsRangeError(() => new Uint8Array((1 << 23) + 1).toHex()),
);
check(
	"typed-array base64 rejects expansion past the limit",
	throwsRangeError(() => new Uint8Array(12582913).toBase64()),
);
check(
	"typed-array base64 remains correct",
	new Uint8Array([102, 111, 111]).toBase64() === "Zm9v" &&
		new Uint8Array([102]).toBase64() === "Zg==",
);
check("typed-array hex remains correct", new Uint8Array([0, 255]).toHex() === "00ff");

check("repeat fills non-power-of-two results", "ab".repeat(7) === "ababababababab");
check(
	"repeat empty and zero remain empty",
	"".repeat(1e6) === "" && "abc".repeat(0) === "",
);
check(
	"repeat preserves UTF-16 code units",
	"\ud83d\ude00x".repeat(3) === "\ud83d\ude00x\ud83d\ude00x\ud83d\ude00x",
);
const thresholdRepeat = "01".repeat(1 << 15);
const thresholdPrefix = thresholdRepeat.slice(0, 7);
const thresholdMiddle = thresholdRepeat.slice((1 << 15) - 3, (1 << 15) + 5);
const thresholdSuffix = thresholdRepeat.slice(-7);
check(
	"repeat remains correct at the lazy threshold",
	thresholdRepeat.length === 1 << 16 &&
		thresholdPrefix === "0101010" &&
		thresholdMiddle === "10101010" &&
		thresholdSuffix === "1010101",
);
check(
	"repeat one remains the source value",
	thresholdRepeat.repeat(1) === thresholdRepeat,
);

check("concat remains correct", "a" + "\ud83d\ude00" + "b" === "a\ud83d\ude00b");
check(
	"String.prototype.concat remains correct",
	"a".concat("\ud83d\ude00", "b") === "a\ud83d\ude00b",
);
check(
	"primitive concat handles inline, empty, and flat owned parts",
	"ab".concat("", "c", "d") === "abcd" &&
		"route".concat("/", "users", "/", "active", "?page=1") ===
			"route/users/active?page=1",
);
check("empty String.prototype.concat remains correct", "".concat("") === "");
let concatReceiverCoercions = 0;
check(
	"zero-argument concat still coerces its receiver",
	String.prototype.concat.call({
		toString() {
			concatReceiverCoercions++;
			return "receiver";
		},
	}) === "receiver" && concatReceiverCoercions === 1,
);
check(
	"toWellFormed preserves valid units and replaces lone surrogates",
	"plain\ud83d\ude00".toWellFormed() === "plain\ud83d\ude00" &&
		"\ud800a\udc00".toWellFormed() === "\ufffda\ufffd",
);
const gcWellFormed = String.prototype.toWellFormed.call({
	toString: () => "w".repeat(1024) + "\ud800",
});
check(
	"toWellFormed roots a coerced receiver through managed allocation",
	gcWellFormed.length === 1025 && gcWellFormed.slice(-2) === "w\ufffd",
);
check(
	"String constructs flat symbol descriptions",
	String(Symbol()) === "Symbol()" &&
		String(Symbol("description")) === "Symbol(description)",
);
const staticStringOrder = [];
function gcCode(name, value) {
	return {
		valueOf() {
			staticStringOrder.push(name);
			forceGc();
			return value;
		},
	};
}
check(
	"String code-unit and code-point builders preserve ordered coercion under GC",
	String.fromCharCode(gcCode("char-a", 65), gcCode("char-b", 66)) === "AB" &&
		String.fromCodePoint(
			gcCode("point-a", 65),
			gcCode("point-face", 0x1f600),
			gcCode("point-b", 66),
			gcCode("point-c", 67),
		) === "A\ud83d\ude00BC" &&
		staticStringOrder.join(",") === "char-a,char-b,point-a,point-face,point-b,point-c",
);
let throwingStringPrototypeReads = 0;
let throwingStringConstruction = false;
try {
	Reflect.construct(
		String,
		[Symbol("cannot-wrap")],
		new Proxy(function () {}, {
			get(target, key, receiver) {
				if (key === "prototype") throwingStringPrototypeReads++;
				return Reflect.get(target, key, receiver);
			},
		}),
	);
} catch (error) {
	throwingStringConstruction = error instanceof TypeError;
}
check(
	"throwing String construction stops before custom prototype lookup",
	throwingStringConstruction && throwingStringPrototypeReads === 0,
);
const boxedString = Reflect.construct(
	String,
	[{ toString: () => "boxed-" + "b".repeat(64) }],
	new Proxy(function () {}, {
		get(target, key, receiver) {
			if (key === "prototype") {
				forceGc();
				return { marker: "fresh-string-prototype" };
			}
			return Reflect.get(target, key, receiver);
		},
	}),
);
check(
	"String construction roots coerced data and custom prototype",
	Object.getPrototypeOf(boxedString).marker === "fresh-string-prototype" &&
		String.prototype.valueOf.call(boxedString) === "boxed-" + "b".repeat(64),
);
const htmlOrder = [];
const htmlResult = String.prototype.link.call(
	{
		toString() {
			htmlOrder.push("receiver");
			return "body-" + "d".repeat(64);
		},
	},
	{
		toString() {
			htmlOrder.push("attribute");
			if (typeof $262 !== "undefined") $262.gc();
			return 'q"' + "v".repeat(64);
		},
	},
);
check(
	"Annex-B HTML emits once after ordered rooted coercions",
	htmlResult ===
		'<a href="q&quot;' + "v".repeat(64) + '">body-' + "d".repeat(64) + "</a>" &&
		htmlOrder.join(",") === "receiver,attribute" &&
		"x".bold() === "<b>x</b>",
);
const rawOrder = [];
const rawSegments = {
	get length() {
		rawOrder.push("length");
		return {
			valueOf() {
				rawOrder.push("lengthValue");
				return 2;
			},
		};
	},
	get 0() {
		rawOrder.push("zero");
		return {
			toString() {
				rawOrder.push("zeroString");
				return "a".repeat(64);
			},
		};
	},
	get 1() {
		rawOrder.push("one");
		if (typeof $262 !== "undefined") $262.gc();
		return {
			toString() {
				rawOrder.push("oneString");
				return "c".repeat(64);
			},
		};
	},
};
const rawResult = String.raw(
	{
		get raw() {
			rawOrder.push("raw");
			return rawSegments;
		},
	},
	{
		toString() {
			rawOrder.push("substitution");
			if (typeof $262 !== "undefined") $262.gc();
			return "b".repeat(64);
		},
	},
);
check(
	"String.raw preserves coercion order and roots exact-builder parts",
	rawResult === "a".repeat(64) + "b".repeat(64) + "c".repeat(64) &&
		rawOrder.join(",") ===
			"raw,length,lengthValue,zero,zeroString,substitution,one,oneString",
);
const hugeRawError = {};
let hugeRawFirstRead = false;
let hugeRawThrew = false;
try {
	String.raw({
		raw: {
			length: 2 ** 32,
			get 0() {
				hugeRawFirstRead = true;
				throw hugeRawError;
			},
		},
	});
} catch (error) {
	hugeRawThrew = error === hugeRawError;
}
check(
	"String.raw does not truncate large LengthOfArrayLike values",
	hugeRawFirstRead && hugeRawThrew,
);
let rawMissingTemplateThrows = false;
try {
	String.raw();
} catch (error) {
	rawMissingTemplateThrows = error instanceof TypeError;
}
check("String.raw requires a template", rawMissingTemplateThrows);
check("string replacement remains correct", "aba".replaceAll("a", "$&$") === "a$ba$");
check(
	"literal string replacement preserves replace and replaceAll boundaries",
	"alpha/beta/alpha".replaceAll("alpha", "item") === "item/beta/item" &&
		"abc".replace("", "-") === "-abc" &&
		"abc".replaceAll("", "-") === "-a-b-c-" &&
		"same".replaceAll("a", "a") === "same",
);
let noMatchReplacementCoercions = 0;
let noMatchCallbackCalls = 0;
check(
	"literal replacement preserves no-match coercion and callback behavior",
	"abc".replace("missing", {
		toString() {
			noMatchReplacementCoercions++;
			return "replacement";
		},
	}) === "abc" &&
		"abc".replaceAll("missing", () => {
			noMatchCallbackCalls++;
			return "replacement";
		}) === "abc" &&
		noMatchReplacementCoercions === 1 &&
		noMatchCallbackCalls === 0,
);
const gcNoMatchSubject = "subject-" + "s".repeat(64);
const gcNoMatchReplace = String.prototype.replace.call(
	{ toString: () => "subject-" + "s".repeat(64) },
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "missing-" + "m".repeat(64);
		},
	},
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "replacement-" + "r".repeat(64);
		},
	},
);
check(
	"no-match replacement roots object-coerced receiver and search strings",
	gcNoMatchReplace === gcNoMatchSubject,
);
const gcFunctionalReplacement = String.prototype.replaceAll.call(
	{ toString: () => "x-x" },
	{
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "x";
		},
	},
	() => ({
		toString() {
			if (typeof $262 !== "undefined") $262.gc();
			return "y".repeat(32);
		},
	}),
);
check(
	"functional replacement roots coerced callback results",
	gcFunctionalReplacement === "y".repeat(32) + "-" + "y".repeat(32),
);
check("regexp replacement remains correct", "aba".replace(/(a)/g, "$1$") === "a$ba$");
const builderGrowth = "0123456789abcdef".repeat(32);
check(
	"JSON builders grow and finish empty strings",
	JSON.stringify({ value: builderGrowth }) === '{"value":"' + builderGrowth + '"}' &&
		JSON.parse('""') === "",
);
check(
	"replacement builders grow and finish empty strings",
	"x".repeat(256).replaceAll("x", "yz") === "yz".repeat(256) &&
		"".replaceAll("", "") === "",
);
check(
	"regexp builders grow and finish empty strings",
	"x".repeat(256).replace(/x/g, "yz") === "yz".repeat(256) && "".replace(/x/g, "") === "",
);
check(
	"URI builders grow and finish empty strings",
	encodeURIComponent("%".repeat(128)) === "%25".repeat(128) &&
		encodeURIComponent("") === "" &&
		decodeURIComponent("") === "",
);

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
