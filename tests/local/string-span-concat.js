"use strict";
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_CONCAT_MODE ?? "range";
const rows = [],
	events = [];
function observe(value) {
	collect();
	return value;
}
function range(source, a, b, escape) {
	const part = source.slice(1, -1);
	const out = part.concat(a, b);
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function split(source, a, b, escape) {
	const part = source.split("|")[1];
	const out = part.concat(a, b);
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function capture(source, a, b, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const out = part.concat(a, b);
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function nested(source, a, b, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const out = part.concat(a, b);
	collect();
	return escape ? [out, escape(parent), escape(part), escape(part)] : out;
}
function whole(source, argument) {
	const part = source.toString();
	return part.concat(argument);
}
function zero(source) {
	const part = source.slice(1, -1);
	return part.concat();
}
function eight(source, a) {
	const part = source.slice(1, -1);
	return part.concat(a, 0, -0, NaN, true, null, undefined, 12345678901234567890n);
}
function nine(source) {
	const part = source.slice(1, -1);
	return part.concat(1, 2, 3, 4, 5, 6, 7, 8, 9);
}
function alias(source) {
	const part = source.slice(1, -1);
	return part.concat(part, part);
}
function effect(source, hook) {
	const part = source.slice(1, -1);
	return part.concat(hook(1), hook(2));
}
function missing(source, hook) {
	const part = source.split("|")[1];
	return part.concat(hook());
}
function optional(source) {
	const part = /\|(a)?b\|/.exec(source)[1];
	return part.concat("x");
}
function empty(source) {
	const part = source.slice(0, 0);
	return part.concat(source);
}
globalThis.concatRange = range;
globalThis.concatSplit = split;
globalThis.concatCapture = capture;
globalThis.concatNested = nested;
globalThis.concatWhole = whole;
globalThis.concatZero = zero;
globalThis.concatEight = eight;
globalThis.concatNine = nine;
globalThis.concatAlias = alias;
globalThis.concatEffect = effect;
globalThis.concatMissing = missing;
globalThis.concatOptional = optional;
globalThis.concatEmpty = empty;
if (mode !== "fallback") {
	const visit =
		mode === "range"
			? globalThis.concatRange
			: mode === "split"
				? globalThis.concatSplit
				: mode === "regexp"
					? globalThis.concatCapture
					: globalThis.concatNested;
	for (const text of ["", "ab", "éÿ", "a😀b", "\ud800", "\udc00", " \t12\ufeff "])
		for (const pair of [
			["", ""],
			["<", ">"],
			[undefined, null],
			[true, false],
			[-0, NaN],
			[Infinity, -Infinity],
			[1n, 12345678901234567890n],
		])
			rows.push(
				visit(
					mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y",
					pair[0],
					pair[1],
					pair[0] === "<" ? observe : null,
				),
			);
	const rope = "a".repeat(3000) + "😀" + "b".repeat(3000);
	rows.push(
		visit(
			mode === "split" || mode === "regexp" ? "x|" + rope + "|y" : "x" + rope + "y",
			"é".repeat(64),
			"\udc00",
			observe,
		),
	);
	if (mode === "range")
		rows.push(
			globalThis.concatZero("xaby"),
			globalThis.concatZero("xy"),
			globalThis.concatEight("xaby", "!"),
			globalThis.concatAlias("x😀y"),
			globalThis.concatNine("xaby"),
			globalThis.concatEmpty("complete"),
			globalThis.concatWhole("ab", "cd"),
			globalThis.concatWhole("a".repeat(3000), "b".repeat(3000)),
		);
} else {
	const value = (name, result) => ({
		[Symbol.toPrimitive](hint) {
			events.push(name, hint);
			collect();
			return result;
		},
	});
	rows.push(
		globalThis.concatRange("xaby", value("first", "A"), value("second", "B"), observe),
	);
	const marker = { fresh: true };
	try {
		globalThis.concatRange(
			"xaby",
			{
				toString() {
					events.push("throw");
					collect();
					throw marker;
				},
			},
			value("unreached", "!"),
			false,
		);
		throw new Error("missing original throw");
	} catch (e) {
		if (e !== marker) throw e;
		rows.push("original");
	}
	try {
		globalThis.concatRange("xaby", Symbol("bad"), value("unreached", "!"), false);
		throw new Error("missing Symbol throw");
	} catch (e) {
		if (!(e instanceof TypeError)) throw e;
		rows.push("symbol");
	}
	rows.push(
		globalThis.concatEffect("xaby", (index) => {
			events.push("evaluate" + index);
			collect();
			return value("convert" + index, index);
		}),
	);
	try {
		globalThis.concatEffect("xaby", () => {
			throw marker;
		});
		throw new Error("missing argument throw");
	} catch (e) {
		if (e !== marker) throw e;
		rows.push("argument");
	}
	for (const run of [
		() =>
			globalThis.concatMissing("missing", () => {
				throw new Error("missing receiver evaluated args");
			}),
		() => globalThis.concatOptional("|b|"),
	]) {
		try {
			run();
			throw new Error("missing receiver throw");
		} catch (e) {
			if (!(e instanceof TypeError)) throw e;
			rows.push("missing");
		}
	}
	rows.push(
		globalThis.concatRange(
			{
				slice() {
					events.push("slice");
					return {
						concat(a, b) {
							events.push(this !== null, a, b);
							collect();
							return "custom";
						},
					};
				},
			},
			1,
			2,
			false,
		),
	);
	if (process.env.SPAN_CONCAT_PRIMORDIALS !== "locked") {
		const original = String.prototype.concat;
		try {
			rows.push(
				globalThis.concatEffect("xaby", (index) => {
					if (index === 1)
						String.prototype.concat = function (...args) {
							events.push("replacement", String(this), args.length);
							return "changed";
						};
					return index;
				}),
			);
			rows.push(globalThis.concatRange("xaby", 1, 2, false));
			String.prototype.concat = String.prototype.slice;
			rows.push(globalThis.concatRange("xaby", 0, 1, false));
			String.prototype.concat = original;
			rows.push(
				globalThis.concatRange(
					"xaby",
					{
						toString() {
							String.prototype.concat = () => {
								throw new Error("replayed method");
							};
							collect();
							return "captured";
						},
					},
					"!",
					false,
				),
			);
			Object.defineProperty(String.prototype, "concat", {
				configurable: true,
				get() {
					events.push("get concat", String(this));
					collect();
					return original;
				},
			});
			rows.push(globalThis.concatRange("xaby", "getter", "!", false));
			Object.defineProperty(String.prototype, "concat", {
				value: original,
				writable: true,
				configurable: true,
			});
		} finally {
			Object.defineProperty(String.prototype, "concat", {
				value: original,
				writable: true,
				configurable: true,
			});
		}
	}
}
console.log(JSON.stringify([rows, events]));
