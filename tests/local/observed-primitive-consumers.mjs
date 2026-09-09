const results = [];
function record(label, action) {
	try {
		const value = action(),
			kind = typeof value;
		results.push(
			label +
				":" +
				kind +
				":" +
				(kind === "number"
					? Object.is(value, -0)
						? "-0"
						: String(value)
					: kind === "bigint"
						? String(value)
						: kind === "symbol"
							? value.toString()
							: JSON.stringify(value)),
		);
	} catch (error) {
		results.push(label + ":error:" + error.name);
	}
}

let effects = 0;
globalThis.sink = () => effects++;
const value0 = " abcdefé ";
function observed0(x) {
	globalThis.sink(value0, x);
	return value0.charAt(2);
}
globalThis.observed0 = observed0;
const value1 = " abcdefé ";
function observed1(x) {
	globalThis.sink(value1, x);
	return value1.charCodeAt(2);
}
globalThis.observed1 = observed1;
const value2 = " abcdefé ";
function observed2(x) {
	globalThis.sink(value2, x);
	return value2.codePointAt(2);
}
globalThis.observed2 = observed2;
const value3 = " abcdefé ";
function observed3(x) {
	globalThis.sink(value3, x);
	return value3.at(2);
}
globalThis.observed3 = observed3;
const value4 = " abcdefé ";
function observed4(x) {
	globalThis.sink(value4, x);
	return value4.indexOf("b");
}
globalThis.observed4 = observed4;
const value5 = " abcdefé ";
function observed5(x) {
	globalThis.sink(value5, x);
	return value5.lastIndexOf("b");
}
globalThis.observed5 = observed5;
const value6 = " abcdefé ";
function observed6(x) {
	globalThis.sink(value6, x);
	return value6.includes("b");
}
globalThis.observed6 = observed6;
const value7 = " abcdefé ";
function observed7(x) {
	globalThis.sink(value7, x);
	return value7.startsWith(" ");
}
globalThis.observed7 = observed7;
const value8 = " abcdefé ";
function observed8(x) {
	globalThis.sink(value8, x);
	return value8.endsWith(" ");
}
globalThis.observed8 = observed8;
const value9 = " abcdefé ";
function observed9(x) {
	globalThis.sink(value9, x);
	return value9.slice(2, 4);
}
globalThis.observed9 = observed9;
const value10 = " abcdefé ";
function observed10(x) {
	globalThis.sink(value10, x);
	return value10.substring(2, 4);
}
globalThis.observed10 = observed10;
const value11 = " abcdefé ";
function observed11(x) {
	globalThis.sink(value11, x);
	return value11.substr(2, 4);
}
globalThis.observed11 = observed11;
const value12 = " abcdefé ";
function observed12(x) {
	globalThis.sink(value12, x);
	return value12.anchor(2);
}
globalThis.observed12 = observed12;
const value13 = " abcdefé ";
function observed13(x) {
	globalThis.sink(value13, x);
	return value13.big(2);
}
globalThis.observed13 = observed13;
const value14 = " abcdefé ";
function observed14(x) {
	globalThis.sink(value14, x);
	return value14.blink(2);
}
globalThis.observed14 = observed14;
const value15 = " abcdefé ";
function observed15(x) {
	globalThis.sink(value15, x);
	return value15.bold(2);
}
globalThis.observed15 = observed15;
const value16 = " abcdefé ";
function observed16(x) {
	globalThis.sink(value16, x);
	return value16.fixed(2);
}
globalThis.observed16 = observed16;
const value17 = " abcdefé ";
function observed17(x) {
	globalThis.sink(value17, x);
	return value17.fontcolor(2);
}
globalThis.observed17 = observed17;
const value18 = " abcdefé ";
function observed18(x) {
	globalThis.sink(value18, x);
	return value18.fontsize(2);
}
globalThis.observed18 = observed18;
const value19 = " abcdefé ";
function observed19(x) {
	globalThis.sink(value19, x);
	return value19.italics(2);
}
globalThis.observed19 = observed19;
const value20 = " abcdefé ";
function observed20(x) {
	globalThis.sink(value20, x);
	return value20.link(2);
}
globalThis.observed20 = observed20;
const value21 = " abcdefé ";
function observed21(x) {
	globalThis.sink(value21, x);
	return value21.small(2);
}
globalThis.observed21 = observed21;
const value22 = " abcdefé ";
function observed22(x) {
	globalThis.sink(value22, x);
	return value22.strike(2);
}
globalThis.observed22 = observed22;
const value23 = " abcdefé ";
function observed23(x) {
	globalThis.sink(value23, x);
	return value23.sub(2);
}
globalThis.observed23 = observed23;
const value24 = " abcdefé ";
function observed24(x) {
	globalThis.sink(value24, x);
	return value24.sup(2);
}
globalThis.observed24 = observed24;
const value25 = " abcdefé ";
function observed25(x) {
	globalThis.sink(value25, x);
	return value25.concat(2);
}
globalThis.observed25 = observed25;
const value26 = " abcdefé ";
function observed26(x) {
	globalThis.sink(value26, x);
	return value26.normalize("NFC");
}
globalThis.observed26 = observed26;
const value27 = " abcdefé ";
function observed27(x) {
	globalThis.sink(value27, x);
	return value27.repeat(2);
}
globalThis.observed27 = observed27;
const value28 = " abcdefé ";
function observed28(x) {
	globalThis.sink(value28, x);
	return value28.trim(2);
}
globalThis.observed28 = observed28;
const value29 = " abcdefé ";
function observed29(x) {
	globalThis.sink(value29, x);
	return value29.trimStart(2);
}
globalThis.observed29 = observed29;
const value30 = " abcdefé ";
function observed30(x) {
	globalThis.sink(value30, x);
	return value30.trimEnd(2);
}
globalThis.observed30 = observed30;
const value31 = " abcdefé ";
function observed31(x) {
	globalThis.sink(value31, x);
	return value31.trimLeft(2);
}
globalThis.observed31 = observed31;
const value32 = " abcdefé ";
function observed32(x) {
	globalThis.sink(value32, x);
	return value32.trimRight(2);
}
globalThis.observed32 = observed32;
const value33 = " abcdefé ";
function observed33(x) {
	globalThis.sink(value33, x);
	return value33.toUpperCase(2);
}
globalThis.observed33 = observed33;
const value34 = " abcdefé ";
function observed34(x) {
	globalThis.sink(value34, x);
	return value34.toLowerCase(2);
}
globalThis.observed34 = observed34;
const value35 = " abcdefé ";
function observed35(x) {
	globalThis.sink(value35, x);
	return value35.isWellFormed(2);
}
globalThis.observed35 = observed35;
const value36 = " abcdefé ";
function observed36(x) {
	globalThis.sink(value36, x);
	return value36.toWellFormed(2);
}
globalThis.observed36 = observed36;
const value37 = " abcdefé ";
function observed37(x) {
	globalThis.sink(value37, x);
	return value37.split("b");
}
globalThis.observed37 = observed37;
const value38 = " abcdefé ";
function observed38(x) {
	globalThis.sink(value38, x);
	return value38.replace("a", "z");
}
globalThis.observed38 = observed38;
const value39 = " abcdefé ";
function observed39(x) {
	globalThis.sink(value39, x);
	return value39.replaceAll("a", "z");
}
globalThis.observed39 = observed39;
const value40 = " abcdefé ";
function observed40(x) {
	globalThis.sink(value40, x);
	return value40.padStart(8, "_");
}
globalThis.observed40 = observed40;
const value41 = " abcdefé ";
function observed41(x) {
	globalThis.sink(value41, x);
	return value41.padEnd(8, "_");
}
globalThis.observed41 = observed41;
const value42 = " abcdefé ";
function observed42(x) {
	globalThis.sink(value42, x);
	return value42.toString(1);
}
globalThis.observed42 = observed42;
const value43 = " abcdefé ";
function observed43(x) {
	globalThis.sink(value43, x);
	return value43.valueOf(2);
}
globalThis.observed43 = observed43;
const value44 = false;
function observed44(x) {
	globalThis.sink(value44, x);
	return value44.toString(1);
}
globalThis.observed44 = observed44;
const value45 = false;
function observed45(x) {
	globalThis.sink(value45, x);
	return value45.valueOf(2);
}
globalThis.observed45 = observed45;
const value46 = 12.5;
function observed46(x) {
	globalThis.sink(value46, x);
	return value46.toString(10);
}
globalThis.observed46 = observed46;
const value47 = 12.5;
function observed47(x) {
	globalThis.sink(value47, x);
	return value47.valueOf(2);
}
globalThis.observed47 = observed47;
const value48 = 12.5;
function observed48(x) {
	globalThis.sink(value48, x);
	return value48.toFixed(2);
}
globalThis.observed48 = observed48;
const value49 = 12.5;
function observed49(x) {
	globalThis.sink(value49, x);
	return value49.toExponential(2);
}
globalThis.observed49 = observed49;
const value50 = 12.5;
function observed50(x) {
	globalThis.sink(value50, x);
	return value50.toPrecision(2);
}
globalThis.observed50 = observed50;
const value51 = 123n;
function observed51(x) {
	globalThis.sink(value51, x);
	return value51.toString(10);
}
globalThis.observed51 = observed51;
const value52 = 123n;
function observed52(x) {
	globalThis.sink(value52, x);
	return value52.valueOf(2);
}
globalThis.observed52 = observed52;
const value53 = Symbol.iterator;
function observed53(x) {
	globalThis.sink(value53, x);
	return value53.toString(1);
}
globalThis.observed53 = observed53;
const value54 = Symbol.iterator;
function observed54(x) {
	globalThis.sink(value54, x);
	return value54.valueOf(2);
}
globalThis.observed54 = observed54;
const value55 = -12.5;
function observed55(x) {
	globalThis.sink(value55, x);
	return Math.abs(value55);
}
globalThis.observed55 = observed55;
const value56 = 12.5;
function observed56(x) {
	globalThis.sink(value56, x);
	return Math.pow(value56, 0);
}
globalThis.observed56 = observed56;
const value57 = -0.5;
function observed57(x) {
	globalThis.sink(value57, x);
	return Math.round(value57);
}
globalThis.observed57 = observed57;
const value58 = 12.5;
function observed58(x) {
	globalThis.sink(value58, x);
	return Number.isFinite(value58);
}
globalThis.observed58 = observed58;
const value59 = 0;
function observed59(x) {
	globalThis.sink(value59, x);
	return Boolean(value59);
}
globalThis.observed59 = observed59;
const value60 = "123.5";
function observed60(x) {
	globalThis.sink(value60, x);
	return Number(value60);
}
globalThis.observed60 = observed60;
const value61 = "12345678901234567890";
function observed61(x) {
	globalThis.sink(value61, x);
	return BigInt(value61);
}
globalThis.observed61 = observed61;
const value62 = Symbol.iterator;
function observed62(x) {
	globalThis.sink(value62, x);
	return String(value62);
}
globalThis.observed62 = observed62;
const value63 = "a b";
function observed63(x) {
	globalThis.sink(value63, x);
	return encodeURIComponent(value63);
}
globalThis.observed63 = observed63;
const value64 = "a%20b";
function observed64(x) {
	globalThis.sink(value64, x);
	return decodeURIComponent(value64);
}
globalThis.observed64 = observed64;
record("String.prototype.charAt", () =>
	globalThis.observed0({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.charCodeAt", () =>
	globalThis.observed1({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.codePointAt", () =>
	globalThis.observed2({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.at", () =>
	globalThis.observed3({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.indexOf", () =>
	globalThis.observed4({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.lastIndexOf", () =>
	globalThis.observed5({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.includes", () =>
	globalThis.observed6({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.startsWith", () =>
	globalThis.observed7({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.endsWith", () =>
	globalThis.observed8({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.slice", () =>
	globalThis.observed9({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.substring", () =>
	globalThis.observed10({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.substr", () =>
	globalThis.observed11({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.anchor", () =>
	globalThis.observed12({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.big", () =>
	globalThis.observed13({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.blink", () =>
	globalThis.observed14({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.bold", () =>
	globalThis.observed15({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.fixed", () =>
	globalThis.observed16({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.fontcolor", () =>
	globalThis.observed17({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.fontsize", () =>
	globalThis.observed18({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.italics", () =>
	globalThis.observed19({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.link", () =>
	globalThis.observed20({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.small", () =>
	globalThis.observed21({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.strike", () =>
	globalThis.observed22({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.sub", () =>
	globalThis.observed23({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.sup", () =>
	globalThis.observed24({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.concat", () =>
	globalThis.observed25({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.normalize", () =>
	globalThis.observed26({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.repeat", () =>
	globalThis.observed27({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.trim", () =>
	globalThis.observed28({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.trimStart", () =>
	globalThis.observed29({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.trimEnd", () =>
	globalThis.observed30({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.trimLeft", () =>
	globalThis.observed31({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.trimRight", () =>
	globalThis.observed32({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.toUpperCase", () =>
	globalThis.observed33({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.toLowerCase", () =>
	globalThis.observed34({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.isWellFormed", () =>
	globalThis.observed35({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.toWellFormed", () =>
	globalThis.observed36({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.split", () =>
	globalThis.observed37({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.replace", () =>
	globalThis.observed38({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.replaceAll", () =>
	globalThis.observed39({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.padStart", () =>
	globalThis.observed40({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.padEnd", () =>
	globalThis.observed41({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.toString", () =>
	globalThis.observed42({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String.prototype.valueOf", () =>
	globalThis.observed43({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Boolean.prototype.toString", () =>
	globalThis.observed44({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Boolean.prototype.valueOf", () =>
	globalThis.observed45({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.prototype.toString", () =>
	globalThis.observed46({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.prototype.valueOf", () =>
	globalThis.observed47({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.prototype.toFixed", () =>
	globalThis.observed48({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.prototype.toExponential", () =>
	globalThis.observed49({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.prototype.toPrecision", () =>
	globalThis.observed50({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("BigInt.prototype.toString", () =>
	globalThis.observed51({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("BigInt.prototype.valueOf", () =>
	globalThis.observed52({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Symbol.prototype.toString", () =>
	globalThis.observed53({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Symbol.prototype.valueOf", () =>
	globalThis.observed54({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Math.abs", () =>
	globalThis.observed55({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Math.pow", () =>
	globalThis.observed56({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Math.round", () =>
	globalThis.observed57({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number.isFinite", () =>
	globalThis.observed58({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Boolean", () =>
	globalThis.observed59({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("Number", () =>
	globalThis.observed60({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("BigInt", () =>
	globalThis.observed61({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("String", () =>
	globalThis.observed62({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("encodeURIComponent", () =>
	globalThis.observed63({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("decodeURIComponent", () =>
	globalThis.observed64({
		toString() {
			throw new Error("unused");
		},
	}),
);
record("effects", () => effects);
if (results.some((value) => value.includes(":error:")))
	throw new Error(results.filter((value) => value.includes(":error:")).join("\n"));
function initializedFormat() {
	return initializedNumber.toFixed(2);
}
globalThis.initializedFormat = initializedFormat;
record("before-initialization", () => globalThis.initializedFormat());
const initializedNumber = 12.5;
record("after-initialization", () => globalThis.initializedFormat());
function uninitializedCapture() {
	globalThis.earlyFormat = () => uninitializedText.toUpperCase();
	return;
	const uninitializedText = "never";
}
uninitializedCapture();
record("uninitialized-capture", () => globalThis.earlyFormat());
function capturedFormat(x) {
	const value = " a\ud800é ";
	function format() {
		globalThis.sink(value);
		return value.toWellFormed();
	}
	globalThis.sink(format);
	return [format(), x];
}
record("captured-format", () => capturedFormat(7));
const symbol = Symbol.iterator,
	badDigits = 101,
	nil = null,
	invalidEncoding = "%Q0";
let order = "";
function argument() {
	order += "a";
	return 1;
}
function symbolError() {
	return Math.abs(symbol, argument());
}
function digitsError() {
	return initializedNumber.toFixed(badDigits, argument());
}
function receiverError() {
	return Number.prototype.toFixed.call(symbol, argument());
}
function nullError() {
	return String.prototype.charAt.call(nil, argument());
}
function uriError() {
	return decodeURIComponent(invalidEncoding, argument());
}
for (const action of [symbolError, digitsError, receiverError, nullError, uriError]) {
	order = "";
	record("exception", action);
	record("argument-order", () => order);
}
const text = "aba",
	rawText = "head",
	locale = "en-US",
	half = 0.5;
function replacing(x) {
	return text.replaceAll("a", function (match, index, source) {
		order += match + index + source;
		return x;
	});
}
order = "";
record("replacement-callback", () => replacing("!"));
record("callback-order", () => order);
order = "";
record("replacement-throw", () =>
	replacing({
		toString() {
			order += "c";
			throw new RangeError("stop");
		},
	}),
);
record("callback-throw-order", () => order);
function raw(x) {
	return String.raw({ raw: [rawText, "tail"] }, x);
}
record("raw-substitution", () => raw(3));
order = "";
record("raw-effect", () =>
	raw({
		toString() {
			order += "r";
			return "X";
		},
	}),
);
record("raw-order", () => order);
function compare(x) {
	return "a2".localeCompare("" + x, locale, { numeric: true });
}
record("collation", () => Math.sign(compare("a10")));
function sum() {
	return Math.sumPrecise([half, 1]);
}
// Node does not yet expose Math.sumPrecise; these binary fractions have an exact sum.
record("sum", typeof Math.sumPrecise === "undefined" ? () => 1.5 : sum);
order = "";
record("effectful-index", () =>
	text.charAt({
		valueOf() {
			order += "i";
			return 1;
		},
	}),
);
record("index-order", () => order);
record("split-identity", () => {
	const a = text.split("b"),
		b = text.split("b");
	a[0] = "changed";
	return [a !== b, a, b];
});
record("fresh-symbols", () => {
	const a = Symbol("same"),
		b = Symbol("same");
	globalThis.sink(a, b);
	return [a === b, a.toString(), b.description];
});
record("registry", () => {
	const s = Symbol.for("observed-key");
	globalThis.sink(s);
	return [Symbol.keyFor(s), s === Symbol.for("observed-key")];
});
let changing = "abc";
function changed() {
	return changing.toUpperCase();
}
record("mutable-before", changed);
changing = {
	toUpperCase() {
		return "own";
	},
};
record("mutable-after", changed);
const wrapper = new String("abc");
function wrapped() {
	return wrapper.toUpperCase();
}
record("wrapper-before", wrapped);
wrapper.toUpperCase = () => "override";
record("wrapper-after", wrapped);
if (!Object.isFrozen(String.prototype)) {
	const original = String.prototype.toUpperCase;
	try {
		String.prototype.toUpperCase = function () {
			return "changed:" + this;
		};
		record("mutable-prototype", () => text.toUpperCase());
	} finally {
		String.prototype.toUpperCase = original;
	}
} else results.push('mutable-prototype:string:"changed:aba"');
record("well-known-symbol-key", () => Symbol.keyFor(symbol));
const units = "a😀b";
function codeUnits() {
	globalThis.sink(units);
	return units.length;
}
record("cell-string-length", codeUnits);
record("argument-throws-first", () =>
	Math.abs(
		symbol,
		(() => {
			throw new URIError("argument");
		})(),
	),
);
if (!Object.isFrozen(Math)) {
	const original = Math.abs;
	try {
		Math.abs = () => "changed";
		record("mutable-error-target", () => Math.abs(symbol));
	} finally {
		Math.abs = original;
	}
} else results.push('mutable-error-target:string:"changed"');
console.log(results.join("\n"));
