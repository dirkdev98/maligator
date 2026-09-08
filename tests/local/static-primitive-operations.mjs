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
