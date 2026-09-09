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
					: kind === "symbol"
						? value.toString()
						: JSON.stringify(value)),
		);
	} catch (error) {
		results.push(label + ":error:" + error.name);
	}
}
const stringValue = " abcdefé ";
const booleanValue = false;
const numberValue = 12.5;
const bigintValue = 123n;
const symbolValue = Symbol.iterator;
let observations = 0;
globalThis.sink = function (value) {
	observations += typeof value === "object" ? 1000 : 1;
};
function operation0(x) {
	globalThis.sink(stringValue);
	return stringValue.charAt(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.charAt", () => operation0(value));
function operation1(x) {
	globalThis.sink(stringValue);
	return stringValue.charCodeAt(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.charCodeAt", () => operation1(value));
function operation2(x) {
	globalThis.sink(stringValue);
	return stringValue.codePointAt(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.codePointAt", () => operation2(value));
function operation3(x) {
	globalThis.sink(stringValue);
	return stringValue.at(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.at", () => operation3(value));
function operation4(x) {
	globalThis.sink(stringValue);
	return stringValue.indexOf(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.indexOf", () => operation4(value));
function operation5(x) {
	globalThis.sink(stringValue);
	return stringValue.lastIndexOf(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.lastIndexOf", () => operation5(value));
function operation6(x) {
	globalThis.sink(stringValue);
	return stringValue.includes(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.includes", () => operation6(value));
function operation7(x) {
	globalThis.sink(stringValue);
	return stringValue.startsWith(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.startsWith", () => operation7(value));
function operation8(x) {
	globalThis.sink(stringValue);
	return stringValue.endsWith(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.endsWith", () => operation8(value));
function operation9(x) {
	globalThis.sink(stringValue);
	return stringValue.slice(x, 4);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.slice", () => operation9(value));
function operation10(x) {
	globalThis.sink(stringValue);
	return stringValue.substring(x, 4);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.substring", () => operation10(value));
function operation11(x) {
	globalThis.sink(stringValue);
	return stringValue.substr(x, 4);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("String.prototype.substr", () => operation11(value));
function operation12(x) {
	globalThis.sink(stringValue);
	return stringValue.anchor(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.anchor", () => operation12(value));
function operation13(x) {
	globalThis.sink(stringValue);
	return stringValue.big(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.big", () => operation13(value));
function operation14(x) {
	globalThis.sink(stringValue);
	return stringValue.blink(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.blink", () => operation14(value));
function operation15(x) {
	globalThis.sink(stringValue);
	return stringValue.bold(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.bold", () => operation15(value));
function operation16(x) {
	globalThis.sink(stringValue);
	return stringValue.fixed(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.fixed", () => operation16(value));
function operation17(x) {
	globalThis.sink(stringValue);
	return stringValue.fontcolor(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.fontcolor", () => operation17(value));
function operation18(x) {
	globalThis.sink(stringValue);
	return stringValue.fontsize(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.fontsize", () => operation18(value));
function operation19(x) {
	globalThis.sink(stringValue);
	return stringValue.italics(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.italics", () => operation19(value));
function operation20(x) {
	globalThis.sink(stringValue);
	return stringValue.link(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.link", () => operation20(value));
function operation21(x) {
	globalThis.sink(stringValue);
	return stringValue.small(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.small", () => operation21(value));
function operation22(x) {
	globalThis.sink(stringValue);
	return stringValue.strike(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.strike", () => operation22(value));
function operation23(x) {
	globalThis.sink(stringValue);
	return stringValue.sub(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.sub", () => operation23(value));
function operation24(x) {
	globalThis.sink(stringValue);
	return stringValue.sup(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.sup", () => operation24(value));
function operation25(x) {
	globalThis.sink(stringValue);
	return stringValue.concat(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.concat", () => operation25(value));
function operation26(x) {
	globalThis.sink(stringValue);
	return stringValue.localeCompare(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.localeCompare", () => operation26(value));
function operation27(x) {
	globalThis.sink(stringValue);
	return stringValue.normalize(x);
}
for (const value of ["NFC", "NFD", "NFKC", "NFKD", "bad", undefined, Symbol("x")])
	record("String.prototype.normalize", () => operation27(value));
function operation28(x) {
	globalThis.sink(stringValue);
	return stringValue.repeat(x);
}
for (const value of [-1, -0, 0, 1.5, 2, NaN, Infinity, Symbol("x"), 2n])
	record("String.prototype.repeat", () => operation28(value));
function operation29(x) {
	globalThis.sink(stringValue);
	return stringValue.trim(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.trim", () => operation29(value));
function operation30(x) {
	globalThis.sink(stringValue);
	return stringValue.trimStart(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.trimStart", () => operation30(value));
function operation31(x) {
	globalThis.sink(stringValue);
	return stringValue.trimEnd(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.trimEnd", () => operation31(value));
function operation32(x) {
	globalThis.sink(stringValue);
	return stringValue.trimLeft(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.trimLeft", () => operation32(value));
function operation33(x) {
	globalThis.sink(stringValue);
	return stringValue.trimRight(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.trimRight", () => operation33(value));
function operation34(x) {
	globalThis.sink(stringValue);
	return stringValue.toUpperCase(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.toUpperCase", () => operation34(value));
function operation35(x) {
	globalThis.sink(stringValue);
	return stringValue.toLowerCase(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.toLowerCase", () => operation35(value));
function operation36(x) {
	globalThis.sink(stringValue);
	return stringValue.toLocaleUpperCase(x);
}
for (const value of [undefined, "en", "tr", "bad_locale", Symbol("x")])
	record("String.prototype.toLocaleUpperCase", () => operation36(value));
function operation37(x) {
	globalThis.sink(stringValue);
	return stringValue.toLocaleLowerCase(x);
}
for (const value of [undefined, "en", "tr", "bad_locale", Symbol("x")])
	record("String.prototype.toLocaleLowerCase", () => operation37(value));
function operation38(x) {
	globalThis.sink(stringValue);
	return stringValue.isWellFormed(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.isWellFormed", () => operation38(value));
function operation39(x) {
	globalThis.sink(stringValue);
	return stringValue.toWellFormed(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.toWellFormed", () => operation39(value));
function operation40(x) {
	globalThis.sink(stringValue);
	return stringValue.split(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.split", () => operation40(value));
function operation41(x) {
	globalThis.sink(stringValue);
	return stringValue.replace(x, "z");
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.replace", () => operation41(value));
function operation42(x) {
	globalThis.sink(stringValue);
	return stringValue.replaceAll(x, "z");
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.replaceAll", () => operation42(value));
function operation43(x) {
	globalThis.sink(stringValue);
	return stringValue.padStart(8, x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.padStart", () => operation43(value));
function operation44(x) {
	globalThis.sink(stringValue);
	return stringValue.padEnd(8, x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.padEnd", () => operation44(value));
function operation45(x) {
	globalThis.sink(stringValue);
	return stringValue.toString(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.toString", () => operation45(value));
function operation46(x) {
	globalThis.sink(stringValue);
	return stringValue.valueOf(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("String.prototype.valueOf", () => operation46(value));
function operation47(x) {
	globalThis.sink(booleanValue);
	return booleanValue.toString(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("Boolean.prototype.toString", () => operation47(value));
function operation48(x) {
	globalThis.sink(booleanValue);
	return booleanValue.valueOf(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("Boolean.prototype.valueOf", () => operation48(value));
function operation49(x) {
	globalThis.sink(numberValue);
	return numberValue.toString(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("Number.prototype.toString", () => operation49(value));
function operation50(x) {
	globalThis.sink(numberValue);
	return numberValue.valueOf(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("Number.prototype.valueOf", () => operation50(value));
function operation51(x) {
	globalThis.sink(numberValue);
	return numberValue.toFixed(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("Number.prototype.toFixed", () => operation51(value));
function operation52(x) {
	globalThis.sink(numberValue);
	return numberValue.toExponential(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("Number.prototype.toExponential", () => operation52(value));
function operation53(x) {
	globalThis.sink(numberValue);
	return numberValue.toPrecision(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("Number.prototype.toPrecision", () => operation53(value));
function operation54(x) {
	globalThis.sink(bigintValue);
	return bigintValue.toString(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("BigInt.prototype.toString", () => operation54(value));
function operation55(x) {
	globalThis.sink(bigintValue);
	return bigintValue.valueOf(x);
}
for (const value of [
	-1,
	-0,
	0,
	1.5,
	2,
	10,
	36,
	NaN,
	Infinity,
	undefined,
	Symbol("x"),
	2n,
])
	record("BigInt.prototype.valueOf", () => operation55(value));
function operation56(x) {
	globalThis.sink(symbolValue);
	return symbolValue.toString(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("Symbol.prototype.toString", () => operation56(value));
function operation57(x) {
	globalThis.sink(symbolValue);
	return symbolValue.valueOf(x);
}
for (const value of ["", "a", " ", "é", "\ud800", "😀", '"<&', undefined, Symbol("x")])
	record("Symbol.prototype.valueOf", () => operation57(value));

record("all-values-consumed", () => observations);
const loopText = "01234567890123456789";
let loopResult = 0;
for (let i = 0; i < 100; i++) {
	globalThis.sink(loopText);
	loopResult +=
		loopText.indexOf(new String(i)) + loopText.slice(new Number(i & 7), 12).length;
}
record("module-loop", () => loopResult);
function capturedLoop(count) {
	const text = "0123456789";
	globalThis.savedRead = () => text;
	let sum = 0;
	for (let i = 0; i < count; i++) {
		globalThis.sink(text);
		sum += text.indexOf(new String(i & 7));
	}
	return [sum, globalThis.savedRead()];
}
record("captured-loop", () => capturedLoop(100));
function readLate(value) {
	return late.includes(value);
}
record("before-initialization", () => readLate("a"));
const late = "abc";
record("after-initialization", () => readLate("a"));
function makeReader(skip) {
	const read = () => text.includes("a");
	if (skip) return read;
	const text = "abc";
	return read;
}
record("skipped-initialization", () => makeReader(true)());
record("completed-initialization", () => makeReader(false)());
function initializeOrThrow(fail) {
	globalThis.failedRead = () => text.includes("a");
	if (fail) throw new Error("stop");
	const text = "abc";
}
record("failed-initializer", () => initializeOrThrow(true));
record("read-after-failure", () => globalThis.failedRead());
initializeOrThrow(false);
record("read-after-success", () => globalThis.failedRead());
record("reentrant-initializer", () => {
	const read = () => text.toUpperCase();
	const text = read();
	return text;
});
function recursive(depth) {
	const text = depth ? "a" : "b";
	const read = () => text;
	if (depth) {
		const child = recursive(depth - 1);
		return [read(), child];
	}
	return read();
}
record("separate-activations", () => recursive(2));
function freshSymbol() {
	const value = Symbol("cell");
	return () => value;
}
const firstSymbol = freshSymbol(),
	secondSymbol = freshSymbol();
record("fresh-symbol-cells", () => [
	firstSymbol() === firstSymbol(),
	firstSymbol() !== secondSymbol(),
]);
let mutable = "abc";
function readMutable() {
	globalThis.sink(mutable);
	return mutable.includes("a");
}
record("mutable-before", () => readMutable());
mutable = {
	includes(value) {
		return "custom:" + value;
	},
};
record("mutable-after", () => readMutable());
const wrapped = new String("abc");
function readWrapped() {
	globalThis.sink(wrapped);
	return wrapped.includes("a");
}
record("wrapper-before", () => readWrapped());
wrapped.includes = () => "own";
record("wrapper-after", () => readWrapped());
const primitive = "abc";
let seen;
globalThis.sink = (value) => {
	seen = [typeof value, value];
};
record("escaped-primitive", () => {
	globalThis.sink(primitive);
	return [primitive.includes("a"), seen];
});
if (!Object.isFrozen(String.prototype)) {
	const saved = String.prototype.includes;
	try {
		String.prototype.includes = function (value) {
			return "changed:" + this + ":" + value;
		};
		record("mutable-prototype", () => primitive.includes("a"));
	} finally {
		String.prototype.includes = saved;
	}
} else results.push('mutable-prototype:string:"changed:abc:a"');
console.log(results.join("\n"));
