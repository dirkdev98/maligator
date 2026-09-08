function show(value) {
	console.log(typeof value, Object.is(value, -0) ? "-0" : String(value));
}
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
