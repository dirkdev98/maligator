function show(value) {
	console.log(typeof value, Object.is(value, -0) ? "-0" : String(value));
}
function numberPredicates(value) {
	return [
		Number.isFinite.call(null, value),
		Number.isInteger.call(null, value),
		Number.isSafeInteger.call(null, value),
	].join("|");
}
for (const value of [
	null,
	undefined,
	false,
	"",
	"1",
	Symbol("predicate"),
	1n,
	{},
	new Number(1),
	-0,
	1,
	1.5,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 1,
	NaN,
	Infinity,
]) {
	show(numberPredicates(value));
}
show(
	numberPredicates({
		valueOf() {
			throw new Error("predicate coercion");
		},
	}),
);
let predicateEffects = 0;
function predicateInput() {
	predicateEffects++;
	return {};
}
Number.isFinite(predicateInput());
Number.isInteger(predicateInput());
Number.isSafeInteger(predicateInput());
show(predicateEffects);
show((1.25).toFixed(2));
show(Number.MAX_VALUE);
show(Number.MIN_VALUE.toString());
show(Boolean.name);
show(String.prototype.repeat.length);
function wrappedLength(value) {
	return new String(value).length;
}
show(wrappedLength(""));
show(wrappedLength("abc"));
show(wrappedLength("😀"));
show(
	wrappedLength({
		toString() {
			return "abcde";
		},
	}),
);
function wrappedFixed(value) {
	return new Number(value).toFixed(2);
}
show(wrappedFixed(1.25));
function numericFormats(value) {
	return [
		(+value).toString(),
		(+value).toFixed(2),
		(+value).toExponential(),
		(+value).toExponential(4),
		(+value).toPrecision(3),
		(+value).toPrecision(),
	].join("|");
}
for (const value of [
	0,
	-0,
	1.005,
	-1.25,
	1e21,
	Number.MIN_VALUE,
	Number.MAX_VALUE,
	NaN,
	Infinity,
	-Infinity,
]) {
	show(numericFormats(value));
}
let formatEvents = "";
show(
	numericFormats({
		valueOf() {
			formatEvents += "n";
			return 1.25;
		},
	}),
);
show(formatEvents);
function formatOptions(value, digits) {
	return (+value).toExponential(digits);
}
show(
	formatOptions(Infinity, {
		valueOf() {
			formatEvents += "d";
			return -1;
		},
	}),
);
show(formatEvents);
for (const value of [Symbol("number"), 1n]) {
	try {
		show(numericFormats(value));
	} catch (error) {
		show(error.name);
	}
}
function tag(value) {
	return Object.prototype.toString.call(new Boolean(value));
}
show(tag(false));
show(Symbol("x").description);
show(Symbol().description);
show(Symbol().toString());
show(Symbol("a") === Symbol("a"));
show(Symbol.iterator.description);
show(String(Symbol("x")));
show(Object(Symbol("x")).toString());
show(Symbol.for("x") === Symbol.for("x"));
show(Symbol.keyFor(Symbol.for("x")));
show(Symbol.keyFor(Symbol("x")));
let priorSymbol;
for (let index = 0; index < 3; index++) {
	const next = Symbol("repeat");
	show(next === priorSymbol);
	priorSymbol = next;
}
show((1.005).toFixed(2));
show((1000000000000000128).toFixed(0));
show((0.1).toString());
show((5e-324).toString());
show((1.7976931348623157e308).toString());
show((1.25).toPrecision(2));
show((1.25).toExponential(1));
show((255).toString(16));
show(BigInt("0xff"));
show(BigInt(" -170141183460469231731687303715884105728 "));
show(Number(123n));
show(Object(1n).valueOf());
show((-255n).toString(16));
show(parseInt("  -0xfz"));
show(parseInt("-0"));
show(Number.parseFloat("1.25e+2x"));
show(Number.parseFloat("1e+"));
show(isNaN("x"));
show(Number("  1.25e2  "));
show("aba".replace("a", "$$$&"));
show("aba".replaceAll("a", "x"));
show("aba".replaceAll("b", "$`$&$'"));
show("ab".replaceAll("", "-"));
show("x".bold());
show("x".anchor('a"b'));
show(encodeURI("a b?x=😀"));
show(decodeURIComponent("%F0%9F%98%80"));
show(escape("😀"));
show(unescape("%uD800").charCodeAt(0));
function splitResult() {
	return "a,b".split(",");
}
function splitIncludes(value) {
	return "a,b".split(",").includes(value);
}
function firstPart(value) {
	return String(value).split(",")[0];
}
show(firstPart("a,b"));
show(firstPart(""));
show(firstPart(Symbol("a,b")));
show(
	firstPart({
		toString() {
			return "converted,value";
		},
	}),
);
function observeStringWrapper(value) {
	return `${typeof value}:${Object.prototype.toString.call(value)}`;
}
show(new String("abc").split({ [Symbol.split]: observeStringWrapper }));
show(new String("abc").replace({ [Symbol.replace]: observeStringWrapper }, "x"));
show(new String("abc").replaceAll({ [Symbol.replace]: observeStringWrapper }, "x"));
show(new String("abc").match({ [Symbol.match]: observeStringWrapper }));
show(new String("abc").matchAll({ [Symbol.matchAll]: observeStringWrapper }));
show(new String("abc").search({ [Symbol.search]: observeStringWrapper }));
show(splitIncludes("b"));
show(splitIncludes("c"));
const firstSplit = splitResult(),
	secondSplit = splitResult();
firstSplit[0] = "changed";
show(firstSplit !== secondSplit);
show(secondSplit.join("|"));
show(
	"😀"
		.split("")
		.map((x) => x.charCodeAt(0))
		.join(","),
);
show("a,b,c".split(",", 2).join("|"));
show("abc".split(undefined, 0).length);
let callbacks = "";
show(
	"aba".replaceAll("a", (match, index, source) => {
		callbacks += index + ":" + source + ";";
		return "x";
	}),
);
show(callbacks);
for (const operation of [
	() => encodeURI("\ud800"),
	() => decodeURI("%x"),
	() => BigInt("1.5"),
	() => (1).toFixed(101),
	() => Number.prototype.toFixed.call("1", 2),
]) {
	try {
		operation();
		show("missing throw");
	} catch (error) {
		show(error.name);
	}
}
show(Boolean(null));
show(Number());
show(Number("123"));
show(String(false));
show(Number.isNaN(NaN));
show(Number.isFinite(Infinity));
show(Number.isInteger(1.5));
show(Number.isSafeInteger(9007199254740992));
show(isNaN(undefined));
show(isFinite(null));
show(BigInt.asIntN(8, 255n));
show(BigInt.asUintN(8, -1n));
show(BigInt.asIntN(0, -1n));
show(BigInt.asIntN(127, -170141183460469231731687303715884105728n));
show(String.fromCodePoint(128512, 55296).charCodeAt(2));
show(String.fromCharCode(65537, -1).charCodeAt(0));
show("abc".at(-1));
show("abc".charAt(Infinity));
show("abc".charCodeAt(-1));
show("😀".codePointAt(0));
show("😀".codePointAt(1));
show("abc".includes("b"));
show("aba".lastIndexOf("a"));
show("aba".lastIndexOf("a", undefined));
show("aba".lastIndexOf("a", null));
show("abc".endsWith("b", 2));
show("abc".startsWith("b", 1));
show("abc".indexOf("b", NaN));
show("abcdef".slice(-3, -1));
show("abcdef".substring(4, 1));
show("abcdef".substr(-3, 2));
show("a".concat("b", null, 1));
show("ab".repeat(3));
show("a".padStart(4, "xy"));
show("a".padEnd(4, "xy"));
show("\ufeff a\u2028".trim());
show(" a ".trimStart());
show(" a ".trimEnd());
show("\ud800x".isWellFormed());
show("\ud800x".toWellFormed().charCodeAt(0));
show(Math.round(-0.5));
show(Math.min(0, -0));
show(Math.max(-0, 0));
show(Math.trunc(-0.5));

let events = "";
const input = {
	valueOf() {
		events += "v";
		return 7;
	},
	toString() {
		events += "s";
		return "text";
	},
};
function bool(value) {
	return new Boolean(value).valueOf();
}
function num(value) {
	return new Number(value).valueOf();
}
function str(value) {
	return new String(value).valueOf();
}
function predicate(value) {
	return Number.isNaN(value);
}
show(bool(input));
show(predicate(input));
show(events);
function round(value) {
	return Math.round(+value);
}
show(
	round({
		valueOf() {
			events += "r";
			return -0.5;
		},
	}),
);
try {
	round({
		valueOf() {
			events += "t";
			throw new Error("conversion");
		},
	});
} catch (error) {
	show(error.message);
}
try {
	round(Symbol("x"));
} catch (error) {
	show(error.name);
}
show(events);
show(num(input));
show(str(input));
show(events);
function wrapper(value) {
	return new Number(value);
}
const a = wrapper(1),
	b = wrapper(1);
show(a !== b);
show(typeof a);
show(new String("abc").valueOf());
function observeWrappers(value) {
	return [
		!new Boolean(value),
		!new Number(value),
		!new String(value),
		typeof new Boolean(value),
		typeof new Number(value),
		typeof new String(value),
	].join("|");
}
show(observeWrappers(false));
show(observeWrappers(input));
show(events);
for (const observe of [
	(value) => !new Number(value),
	(value) => !new String(value),
	(value) => typeof new Number(value),
	(value) => typeof new String(value),
]) {
	try {
		show(observe(Symbol("wrapper")));
	} catch (error) {
		show(error.name);
	}
}
for (const operation of [
	() => str(Symbol("x")),
	() => num(Symbol("x")),
	() => "a".repeat(-1),
	() => String.fromCodePoint(1114112),
]) {
	try {
		operation();
		show("missing throw");
	} catch (error) {
		show(error.name);
	}
}
const search = {
	get [Symbol.match]() {
		events += "m";
		return false;
	},
	toString() {
		events += "q";
		return "b";
	},
};
const position = {
	valueOf() {
		events += "p";
		return 1;
	},
};
show("abc".includes(search, position));
show(events);
function extra() {
	events += "e";
	return 4;
}
show("abc".slice(1, 2, extra()));
show(events);

function stringChain(value, index) {
	return String(value).slice(1).trim().charCodeAt(+index);
}
function stringConcatLeft(value, index) {
	return (String(value) + value).charCodeAt(+index);
}
function stringConcatRight(value, index) {
	return (value + String(value)).charCodeAt(+index);
}
for (const value of ["a😀z", "  a  ", "\ud800z", "", 1234]) {
	for (const index of [-Infinity, -1, -0, NaN, 0.9, 1, 2, Infinity]) {
		show(stringChain(value, index));
		show(stringConcatLeft(value, index));
		show(stringConcatRight(value, index));
	}
}
events = "";
const chainValue = {
	toString() {
		events += "s";
		return " abc ";
	},
	valueOf() {
		events += "v";
		return 9;
	},
};
const chainIndex = {
	valueOf() {
		events += "i";
		return 1;
	},
};
show(stringChain(chainValue, chainIndex));
show(events);
events = "";
show(stringConcatLeft(chainValue, chainIndex));
show(events);
events = "";
show(stringConcatRight(chainValue, chainIndex));
show(events);
try {
	stringChain("a", Symbol());
} catch (error) {
	show(error.name);
}
try {
	stringConcatLeft(Symbol(), 0);
} catch (error) {
	show(error.name);
}
for (const method of ["replace", "replaceAll", "search", "split", "match", "matchAll"]) {
	const symbol = method === "replaceAll" ? Symbol.replace : Symbol[method];
	const custom = {
		[symbol]() {
			return {
				charCodeAt() {
					return method + ":custom";
				},
			};
		},
	};
	show(String("abc")[method](custom).charCodeAt(0));
}

function stringSearchAll(text, needle, from) {
	show(text.indexOf(needle, +from));
	show(text.lastIndexOf(needle, +from));
	show(text.includes(needle, +from));
	show(text.startsWith(needle, +from));
	show(text.endsWith(needle, +from));
}
function stringSearchDefaults(text, needle) {
	show(text.indexOf(needle));
	show(text.lastIndexOf(needle));
	show(text.includes(needle));
	show(text.startsWith(needle));
	show(text.endsWith(needle));
	show(text.endsWith(needle, undefined));
	show(text.lastIndexOf(needle, undefined));
}
for (const text of ["", "ababa", "a😀\ud800z", "abcd".repeat(40) + "efgh".repeat(40)]) {
	for (const needle of ["", "a", "aba", "😀", "\ud800", "de", "h", "missing"]) {
		stringSearchDefaults(text, needle);
		for (const from of [-Infinity, -1, -0, NaN, 0.9, 1, 3, 10, Infinity]) {
			stringSearchAll(text, needle, from);
		}
	}
}
events = "";
const searchReceiver = {
	toString() {
		events += "r";
		return "abc";
	},
};
const searchNeedle = {
	get [Symbol.match]() {
		events += "m";
		return false;
	},
	toString() {
		events += "n";
		return "b";
	},
};
show(String.prototype.includes.call(searchReceiver, searchNeedle, 1));
show(events);
events = "";
show(String.prototype.indexOf.call(searchReceiver, searchNeedle, 1));
show(events);
try {
	show("abc".includes(/b/, 0));
} catch (error) {
	show(error.name);
}
try {
	show("abc".indexOf(Symbol(), 0));
} catch (error) {
	show(error.name);
}

function stringCharacters(text, index) {
	show(text.at(+index));
	show(text.charAt(+index));
	show(text.charCodeAt(+index));
	show(text.codePointAt(+index));
}
for (const text of ["", "ab", "a😀\ud800z", "abcd".repeat(40) + "efgh".repeat(40)]) {
	for (const index of [-Infinity, -5, -1.9, -0, NaN, 0.9, 1, 2, 3, 1000, Infinity]) {
		stringCharacters(text, index);
	}
}
show(String.prototype.at.call(searchReceiver, -1));
show(String.prototype.charAt.call(searchReceiver, 1));
show(String.prototype.codePointAt.call(searchReceiver, 1));
try {
	show("abc".at(Symbol()));
} catch (error) {
	show(error.name);
}

function numericMath(x, y, z, targetAtan2) {
	show(Math.clz32(+x));
	show(Math.f16round(+x));
	show(Math.fround(+x));
	show(Math.imul(+x, +y));
	show(Math.pow(+x, +y));
	show(Object.is(Math.atan2(+x, +y), targetAtan2(x, y)));
	show(Math.min(+x, +y, +z));
	show(Math.max(+x, +y, +z));
	show(Math.hypot(+x, +y, +z) === Infinity);
	show(Number.isNaN(Math.hypot(+x, +y, +z)));
}
globalThis.numericMath = numericMath;
for (const x of [
	-Infinity,
	-65520,
	-1,
	-0,
	0,
	2 ** -25,
	1 + 2 ** -11,
	65520,
	Infinity,
	NaN,
]) {
	for (const y of [-Infinity, -3, -0, 0, 3, Infinity, NaN])
		numericMath(x, y, 4, Math.atan2);
}
for (const method of [
	"min",
	"max",
	"hypot",
	"pow",
	"atan2",
	"imul",
	"f16round",
	"clz32",
]) {
	events = "";
	const left = {
		valueOf() {
			events += "l";
			return NaN;
		},
	};
	const right = {
		valueOf() {
			events += "r";
			throw new Error("stop");
		},
	};
	try {
		show(Math[method](left, right));
	} catch (error) {
		show(error.message);
	}
	show(events);
}
events = "";
function mathExtra() {
	events += "e";
	return 1;
}
show(Math.pow(2, 3, mathExtra()));
show(Math.f16round(1, mathExtra()));
show(events);
show(Math.pow(NaN, 0));
show(Math.pow(-1, Infinity));
show(Math.pow(1, NaN));
show(Math.hypot(3, 4));
show(Math.hypot(3, 4, 12));
show(Math.hypot(3e200, 4e200) / 1e200);
show(Math.hypot(3e-200, 4e-200) / 1e-200);
let randomInRange = true;
let randomVaries = false;
const randomFirst = Math.random();
for (let i = 0; i < 64; i++) {
	const draw = Math.random();
	randomInRange = randomInRange && draw >= 0 && draw < 1;
	randomVaries = randomVaries || draw !== randomFirst;
}
show(randomInRange && randomVaries);

function unaryMath(x, callbacks) {
	const number = +x;
	const actual = [
		Math.abs(number),
		Math.floor(number),
		Math.ceil(number),
		Math.trunc(number),
		Math.sqrt(number),
		Math.cbrt(number),
		Math.sign(number),
		Math.log(number),
		Math.log2(number),
		Math.log10(number),
		Math.exp(number),
		Math.sin(number),
		Math.cos(number),
		Math.tan(number),
		Math.asin(number),
		Math.acos(number),
		Math.atan(number),
		Math.sinh(number),
		Math.cosh(number),
		Math.tanh(number),
		Math.asinh(number),
		Math.acosh(number),
		Math.atanh(number),
		Math.log1p(number),
		Math.expm1(number),
		Math.fround(number),
		Math.round(number),
	];
	for (let i = 0; i < actual.length; i++) {
		if (!Object.is(actual[i], callbacks[i](number)))
			throw new Error("Math kernel mismatch " + i);
	}
}
globalThis.unaryMath = unaryMath;
const mathCallbacks = [
	Math.abs,
	Math.floor,
	Math.ceil,
	Math.trunc,
	Math.sqrt,
	Math.cbrt,
	Math.sign,
	Math.log,
	Math.log2,
	Math.log10,
	Math.exp,
	Math.sin,
	Math.cos,
	Math.tan,
	Math.asin,
	Math.acos,
	Math.atan,
	Math.sinh,
	Math.cosh,
	Math.tanh,
	Math.asinh,
	Math.acosh,
	Math.atanh,
	Math.log1p,
	Math.expm1,
	Math.fround,
	Math.round,
];
for (const value of [
	-Infinity,
	-65520,
	-1,
	-0.5,
	-0,
	0,
	2 ** -25,
	0.5,
	1,
	65520,
	Infinity,
	NaN,
])
	unaryMath(value, mathCallbacks);
show("Math kernels match target runtime");

function stringRanges(text, start, end) {
	show(String(text).slice(+start, +end));
	show(String(text).substring(+start, +end));
	show(String(text).substr(+start, +end));
	show(String.prototype.slice.call(text, 1));
	show(String.prototype.substring.call(text, 1, undefined));
	show(String.prototype.substr.call(text, -2, undefined));
}
for (const text of ["", "ab", "a😀z", "ab".repeat(80) + "yz".repeat(80)]) {
	for (const start of [-Infinity, -5, -0, NaN, 1.9, 3, Infinity]) {
		for (const end of [-Infinity, -1, -0, NaN, 2.9, 8, Infinity])
			stringRanges(text, start, end);
	}
}
function stringCodes(value) {
	show(String.fromCharCode(65, +value, 0xd800));
	try {
		show(String.fromCodePoint(65, +value, 0xd800));
	} catch (error) {
		show(error.name);
	}
}
for (const value of [
	-Infinity,
	-1,
	-0,
	0,
	0.9,
	0xd800,
	0x10000,
	0x10ffff,
	0x110000,
	2 ** 32 + 97,
	Infinity,
	NaN,
])
	stringCodes(value);
function stringBuilders(text, length, fill) {
	try {
		show(String(text).repeat(+length));
	} catch (error) {
		show(error.name);
	}
	try {
		show(String(text).padStart(+length, fill));
	} catch (error) {
		show(error.name);
	}
	try {
		show(String(text).padEnd(+length, fill));
	} catch (error) {
		show(error.name);
	}
	show(String(text).concat(fill, text));
}
for (const text of ["", "ab", "a😀z", "ab".repeat(80)]) {
	for (const length of [-Infinity, -1, -0, NaN, 0.9, 2, 8, 100, Infinity])
		stringBuilders(text, length, "xy");
}
function paddingEdge(text, length, fill) {
	show(String(text).padStart(+length, fill));
	show(String(text).padEnd(+length, fill));
}
paddingEdge("abc", Infinity, "");
paddingEdge("abc", 1e20, "");
events = "";
const paddingThrow = {
	toString() {
		events += "p";
		throw new Error("filler");
	},
};
try {
	paddingEdge("abc", Infinity, paddingThrow);
} catch (error) {
	show(error.message);
}
show(events);
function wrappedStringMethods(text) {
	show(text.slice(1));
	show(text.substring(1));
	show(text.substr(1));
	show(text.repeat(2));
	show(text.padStart(6, "x"));
	show(text.trim());
	show(text.includes("a"));
	show(text.charAt(1));
	show(text.concat("x"));
}
const customString = new String("original");
customString.toString = function () {
	return " abc ";
};
wrappedStringMethods(customString);
customString[Symbol.toPrimitive] = function (hint) {
	show(hint);
	return "xyz";
};
wrappedStringMethods(customString);
events = "";
const rangeReceiver = {
	toString() {
		events += "r";
		return "abc";
	},
};
const rangeStart = {
	valueOf() {
		events += "s";
		return 1;
	},
};
const rangeEnd = {
	valueOf() {
		events += "e";
		return 2;
	},
};
show(String.prototype.slice.call(rangeReceiver, rangeStart, rangeEnd));
show(events);
events = "";
try {
	String.fromCodePoint(
		{
			valueOf() {
				events += "a";
				return -1;
			},
		},
		{
			valueOf() {
				events += "b";
				return 65;
			},
		},
	);
} catch (error) {
	show(error.name);
}
show(events);

function rawTemplate(value) {
	return String.raw({ raw: ["a", "b", "c"] }, value, value);
}
show(rawTemplate("X"));
events = "";
show(
	rawTemplate({
		toString() {
			events += "x";
			return events;
		},
	}),
);
show(events);
try {
	show(rawTemplate(Symbol()));
} catch (error) {
	show(error.name);
}
show(
	String.raw(
		{ raw: [] },
		{
			toString() {
				throw new Error("unused");
			},
		},
	),
);
show(
	String.raw(
		{ raw: ["only"] },
		{
			toString() {
				throw new Error("unused");
			},
		},
	),
);
events = "";
show(
	String.raw(
		{
			get raw() {
				events += "r";
				return {
					get length() {
						events += "l";
						return 2;
					},
					get 0() {
						events += "a";
						return "a";
					},
					get 1() {
						events += "b";
						return "b";
					},
				};
			},
		},
		{
			toString() {
				events += "s";
				return "s";
			},
		},
	),
);
show(events);
const mutableRaw = ["a", "b"];
show(
	String.raw(
		{ raw: mutableRaw },
		{
			toString() {
				mutableRaw[1] = "changed";
				return "x";
			},
		},
	),
);
show(String.raw({ raw: ["a", , "c"] }, "x", "y"));

function unicodeTransforms(value) {
	return [
		value.toUpperCase(),
		value.toLowerCase(),
		value.normalize(),
		value.normalize("NFD"),
		value.normalize("NFKC"),
		value.normalize("NFKD"),
		value.trim(),
		value.trimStart(),
		value.trimEnd(),
		value.isWellFormed(),
		value.toWellFormed(),
	]
		.map((result) => JSON.stringify(result))
		.join("|");
}
globalThis.unicodeTransforms = unicodeTransforms;
for (const text of [
	"Straße ﬃ",
	"ΟΣ ΟΣΑ AΣ'A AΣ'",
	"İı",
	"\u1e0a\u0323",
	"\u212b",
	"\u0958",
	"\u1100\u1161\u11a8",
	"\u{10400}\u{10428}",
	"\ud800A\u030a\udfff",
	"\ufeff \u2000 x \u2029\u3000",
	"a" + "\u0301".repeat(40) + "\u0323".repeat(40),
])
	show(unicodeTransforms(text));
events = "";
show(
	String.prototype.normalize.call(
		{
			toString() {
				events += "s";
				return "e\u0301";
			},
		},
		{
			toString() {
				events += "f";
				return "NFC";
			},
		},
	),
);
show(events);
for (const form of [null, Symbol(), "nfc", "NFKC"]) {
	try {
		show("\ufb03".normalize(form));
	} catch (error) {
		show(error.name);
	}
}

function replaceStrings(text, search, replacement) {
	const source = String(text),
		needle = String(search);
	show(source.replace(needle, replacement));
	show(source.replaceAll(needle, replacement));
}
globalThis.replaceStrings = replaceStrings;
for (const text of ["", "ababa", "a😀\ud800z", "abcdefgh".repeat(20)]) {
	for (const search of ["", "a", "aba", "😀", "\ud800", "missing"]) {
		for (const replacement of ["", "x", "$$", "$&", "$`", "$'", "$1$<x>", "$$$&$`$'"])
			replaceStrings(text, search, replacement);
	}
}
let replacementEvents = "";
function replacementCallback(match, index, source) {
	replacementEvents += `${this === undefined}:${arguments.length}:${match}:${index}:${source};`;
	return {
		toString() {
			replacementEvents += "convert;";
			return "x";
		},
	};
}
replaceStrings("aba", "a", replacementCallback);
replaceStrings("ab", "", replacementCallback);
show(replacementEvents);
replacementEvents = "";
replaceStrings("aba", "missing", {
	toString() {
		replacementEvents += "convert;";
		return "x";
	},
});
show(replacementEvents);
try {
	replaceStrings("aba", "a", (match, index) => {
		if (index > 0) throw new Error("replacement");
		return match;
	});
} catch (error) {
	show(error.message);
}

function legacyHtml(text, attribute) {
	const source = String(text);
	return [
		source.anchor(attribute),
		source.big(),
		source.blink(),
		source.bold(),
		source.fixed(),
		source.fontcolor(attribute),
		source.fontsize(attribute),
		source.italics(),
		source.link(attribute),
		source.small(),
		source.strike(),
		source.sub(),
		source.sup(),
	].join("|");
}
globalThis.legacyHtml = legacyHtml;
for (const text of ["", "a<&", "😀\ud800", "abc".repeat(30)])
	for (const attribute of [
		undefined,
		null,
		'a"b"<&',
		{
			toString() {
				return 'c"d';
			},
		},
	])
		show(legacyHtml(text, attribute));
let htmlEvents = "";
show(
	legacyHtml(
		{
			toString() {
				htmlEvents += "source;";
				return "a";
			},
		},
		{
			toString() {
				htmlEvents += "attribute;";
				return "b";
			},
		},
	),
);
show(htmlEvents);
try {
	legacyHtml("a", Symbol("attribute"));
} catch (error) {
	show(error.name);
}

function uriEncode(text) {
	const source = String(text);
	return [encodeURI(source), encodeURIComponent(source), escape(source)].join("|");
}
function uriDecode(text) {
	const source = String(text);
	return [decodeURI(source), decodeURIComponent(source), unescape(source)].join("|");
}
globalThis.uriEncode = uriEncode;
globalThis.uriDecode = uriDecode;
for (const text of ["", "abc", "a b?x=#&", "😀中é", "a/b".repeat(50)])
	show(uriEncode(text));
for (const text of ["", "abc", "%2f%3f%23%26%20", "%F0%9F%98%80", "%C3%A9", "%25uD800"])
	show(uriDecode(text));
for (const text of ["\ud800", "\udc00", "a\ud800b"])
	try {
		uriEncode(text);
	} catch (error) {
		show(error.name);
	}
for (const text of [
	"%",
	"%a",
	"%xx",
	"%80",
	"%C0%80",
	"%E0%A0",
	"%ED%A0%80",
	"%F4%90%80%80",
	"%F5%80%80%80",
])
	try {
		uriDecode(text);
	} catch (error) {
		show(error.name);
	}
