"use strict";
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function toStringRange(value, ignored, hook, escape) {
	const part = value.toString(ignored, hook(), ignored);
	const size = part.length;
	if (escape) return [size, part.charCodeAt(0), part.at(-1), escape(part), escape(part)];
	return [size, part.charCodeAt(0), part.at(-1)];
}
function valueOfRange(value, ignored, hook, escape) {
	const part = value.valueOf(ignored, hook(), ignored);
	const size = part.length;
	if (escape) return [size, part.charCodeAt(0), part.at(-1), escape(part), escape(part)];
	return [size, part.charCodeAt(0), part.at(-1)];
}
function range(value, start, end, ignored, hook, escape) {
	const parent = value.slice(start, end);
	const part = parent.toString(ignored, hook(), ignored);
	const child = part.valueOf(ignored, hook(), ignored);
	const size = child.length;
	if (escape) return [size, parent.length, child.at(-1), escape(child), escape(child)];
	return [size, parent.length, child.at(-1)];
}
function split(value, ignored, hook, escape) {
	const parent = value.split("|")[1];
	const part = parent.toString(ignored, hook(), ignored);
	const child = part.valueOf(ignored, hook(), ignored);
	const size = child.length;
	if (escape) return [size, parent.length, child.at(-1), escape(child), escape(child)];
	return [size, parent.length, child.at(-1)];
}
function capture(value, ignored, hook, escape) {
	const parent = /\|([^|]*)\|/.exec(value)[1];
	const part = parent.toString(ignored, hook(), ignored);
	const child = part.valueOf(ignored, hook(), ignored);
	const size = child.length;
	if (escape) return [size, parent.length, child.at(-1), escape(child), escape(child)];
	return [size, parent.length, child.at(-1)];
}
function optional(value, ignored, hook) {
	const part = /\|(a)?b\|/.exec(value)[1];
	const child = part.valueOf(ignored, hook());
	return child.length;
}
function alias(value) {
	const parent = value.slice(1, -1);
	const child = parent.toString(parent);
	return [child.length, child, parent];
}
function generations(values, ignored, hook) {
	let total = 0;
	for (const value of values) {
		const part = value.toString(ignored, hook());
		total += part.length;
	}
	return total;
}
globalThis.identityToString = toStringRange;
globalThis.identityValueOf = valueOfRange;
globalThis.identityRange = range;
globalThis.identitySplit = split;
globalThis.identityCapture = capture;
globalThis.identityOptional = optional;
globalThis.identityAlias = alias;
globalThis.identityGenerations = generations;
const mode = process.env.SPAN_IDENTITY_MODE ?? "toString";
const rows = [],
	events = [];
const poison = new Proxy(
	{},
	{
		get() {
			throw Error("ignored argument inspected");
		},
	},
);
function hook() {
	events.push("argument");
	collect();
	return { fresh: events.length };
}
function observe(value) {
	collect();
	return value;
}
const values = [
	"",
	"abc",
	"12",
	" ",
	"é\0x",
	"a😀b",
	"\ud800",
	"\udc00",
	"x".repeat(1200) + "😀" + "tail",
];
if (mode === "toString" || mode === "valueOf") {
	const method =
		mode === "toString" ? globalThis.identityToString : globalThis.identityValueOf;
	for (const value of values)
		for (const ignored of [poison, Symbol("ignored"), 123n]) {
			rows.push(method(value, ignored, hook, false));
			rows.push(method(value, ignored, hook, observe));
		}
	rows.push(events.length);
} else if (mode === "range" || mode === "split" || mode === "regexp") {
	for (const value of values) {
		const source = "|" + value + "|";
		for (const escape of [false, observe])
			rows.push(
				mode === "range"
					? globalThis.identityRange(source, 1, -1, poison, hook, escape)
					: mode === "split"
						? globalThis.identitySplit(source, poison, hook, escape)
						: globalThis.identityCapture(source, poison, hook, escape),
			);
	}
	if (mode === "range") {
		rows.push(
			globalThis.identityRange("x😀y", 2, 3, Symbol(), hook, observe),
			globalThis.identityAlias("|abc|"),
			globalThis.identityGenerations(values, poison, hook),
		);
	}
	rows.push(events.length);
} else if (mode === "fallback") {
	for (const method of [toStringRange, valueOfRange]) {
		rows.push(
			method(new String("boxed"), poison, hook, observe),
			method(String.prototype, poison, hook, observe),
		);
	}
	let coerced = 0;
	const bad = {
		toString: String.prototype.toString,
		valueOf: String.prototype.valueOf,
		[Symbol.toPrimitive]() {
			coerced++;
			throw Error("coerced");
		},
	};
	let errors = 0;
	for (const method of [toStringRange, valueOfRange])
		for (const value of [bad, new Proxy(new String("x"), {})])
			try {
				method(value, poison, hook, false);
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				errors++;
			}
	for (const call of [
		() => split("missing", poison, hook, false),
		() => capture("missing", poison, hook, false),
		() => optional("|b|", poison, hook),
	]) {
		const before = events.length;
		try {
			call();
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			errors++;
		}
		if (events.length !== before)
			throw Error("argument evaluated after missing receiver");
	}
	const custom = {
		length: 91,
		charCodeAt() {
			return 7;
		},
		at() {
			return "tail";
		},
	};
	rows.push(
		toStringRange(
			{
				toString() {
					return custom;
				},
			},
			poison,
			hook,
			observe,
		),
		valueOfRange(
			{
				valueOf() {
					return custom;
				},
			},
			poison,
			hook,
			observe,
		),
	);
	const marker = { marker: 1 };
	try {
		toStringRange(
			bad,
			poison,
			() => {
				collect();
				throw marker;
			},
			false,
		);
	} catch (error) {
		rows.push(error === marker);
	}
	rows.push(errors, coerced);
	if (process.env.SPAN_IDENTITY_PRIMORDIALS !== "locked") {
		const originalToString = String.prototype.toString,
			originalValueOf = String.prototype.valueOf;
		try {
			rows.push(
				toStringRange(
					"captured",
					poison,
					() => {
						String.prototype.toString = function (a, b, c) {
							return a === poison && c === poison ? "replacement" : "wrong";
						};
						collect();
					},
					observe,
				),
			);
			rows.push(toStringRange("later", poison, hook, observe));
			String.prototype.toString = originalToString;
			String.prototype.valueOf = String.prototype.trim;
			rows.push(valueOfRange("  trimmed  ", poison, hook, observe));
			String.prototype.valueOf = originalValueOf;
			String.prototype.toString = Object.prototype.valueOf;
			rows.push(toStringRange("boxed by wrong family", poison, hook, observe));
		} finally {
			String.prototype.toString = originalToString;
			String.prototype.valueOf = originalValueOf;
		}
	}
	rows.push(events.length);
} else throw Error(mode);
console.log(JSON.stringify(rows));
