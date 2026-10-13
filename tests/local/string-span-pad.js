"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_PAD_MODE;
const rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function summary(output) {
	if (output.length > 1024) return [output.length, output];
	let sum = 0;
	for (let i = 0; i < output.length; i++)
		sum = (sum + output.charCodeAt(i) * ((i % 31) + 1)) >>> 0;
	return [output.length, sum, output.slice(0, 3), output.slice(-3)];
}
function range(source, target, filler, escape) {
	const part = source.slice(1, -1);
	const a = part.padStart(target, filler);
	const b = part.padEnd(target, filler);
	collectGarbage();
	if (escape) return [summary(a), summary(b), observed(part), observed(part)];
	return [summary(a), summary(b)];
}
function split(source, target, filler, escape) {
	const part = source.split("|")[1];
	const a = part.padStart(target, filler);
	const b = part.padEnd(target, filler);
	collectGarbage();
	if (escape) return [summary(a), summary(b), observed(part), observed(part)];
	return [summary(a), summary(b)];
}
function capture(source, target, filler, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const a = part.padStart(target, filler);
	const b = part.padEnd(target, filler);
	collectGarbage();
	if (escape) return [summary(a), summary(b), observed(part), observed(part)];
	return [summary(a), summary(b)];
}
function nested(source, target, filler, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const a = part.padStart(target, filler);
	const b = part.padEnd(target, filler);
	collectGarbage();
	if (escape) return [summary(a), summary(b), observed(parent), observed(part)];
	return [summary(a), summary(b)];
}
function omitted(source) {
	const part = source.slice(1, -1);
	return [part.padStart(), part.padEnd(5)];
}
function extra(source, effect) {
	const part = source.slice(1, -1);
	return part.padStart(5, "_", effect());
}
if (["range", "split", "regexp", "nested"].includes(mode)) {
	const visit =
		mode === "range"
			? range
			: mode === "split"
				? split
				: mode === "regexp"
					? capture
					: nested;
	const source = (text) =>
		mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y";
	for (const text of ["ab", "éÿ", "a😀b", "\ud800", "", " \t12\ufeff "])
		for (const target of [undefined, 0, 1, 2.8, "7", null, true, NaN, -2, 12])
			rows.push(visit(source(text), target, "😀x", target === 1));
	for (const filler of [undefined, "", "_", "😀x", null, false, 12n])
		rows.push(visit(source("ab"), 7, filler, true));
	rows.push(visit(source("ab"), Infinity, "", true));
	const events = [];
	const filler = {
		toString() {
			events.push("fill");
			collectGarbage();
			return "😀";
		},
	};
	rows.push(visit(source("ab"), 7, filler, true));
	rows.push(
		visit(
			source("ab"),
			0,
			{
				toString() {
					throw new Error("unused filler");
				},
			},
			false,
		),
	);
	rows.push(visit(source("ab"), 0, Symbol("ignored"), false));
	for (const target of [Infinity, 1e100]) {
		try {
			visit(source("ab"), target, filler, false);
			throw new Error("missing size error");
		} catch (e) {
			if (!(e instanceof RangeError)) throw e;
			events.push("RangeError");
		}
	}
	try {
		visit(source("ab"), 5, Symbol("bad"), false);
		throw new Error("missing Symbol error");
	} catch (e) {
		if (!(e instanceof TypeError)) throw e;
		events.push("TypeError");
	}
	const marker = { original: "filler" };
	try {
		visit(
			source("ab"),
			Infinity,
			{
				toString() {
					collectGarbage();
					throw marker;
				},
			},
			false,
		);
		throw new Error("missing original");
	} catch (e) {
		if (e !== marker) throw e;
		events.push("original");
	}
	const rope = "a".repeat(20000) + "😀" + "b".repeat(20000);
	rows.push(visit(source(rope), 50003, "\ud800😀", false));
	rows.push(visit(source("a😀b"), 65537, "é😀_", false));
	rows.push(omitted("xaby"), events);
} else if (mode === "fallback") {
	const events = [];
	rows.push(
		range(
			"xaby",
			{
				valueOf() {
					events.push("target");
					collectGarbage();
					return 7;
				},
			},
			{
				toString() {
					events.push("fill");
					collectGarbage();
					return "_";
				},
			},
			true,
		),
	);
	for (const target of [1n, Symbol("bad")]) {
		try {
			range("xaby", target, "_", false);
			throw new Error("missing target error");
		} catch (e) {
			if (!(e instanceof TypeError)) throw e;
			events.push("TypeError");
		}
	}
	let result;
	const source = {
		slice() {
			events.push("slice");
			result = {
				padStart(n, f) {
					events.push(this === result, n, f);
					return "customStart";
				},
				padEnd(n, f) {
					events.push(this === result, n, f);
					return "customEnd";
				},
			};
			return result;
		},
	};
	rows.push(range(source, 5, "_", false));
	let effects = 0;
	rows.push(
		extra("xaby", () => {
			effects++;
			return {
				toString() {
					throw new Error("extra coerced");
				},
			};
		}),
	);
	const marker = { extra: true };
	try {
		extra("xaby", () => {
			effects++;
			throw marker;
		});
		throw new Error("missing extra throw");
	} catch (e) {
		if (e !== marker) throw e;
	}
	if (effects !== 2) throw new Error("argument replay");
	if (process.env.SPAN_PAD_PRIMORDIALS === "mutable") {
		const savedStart = String.prototype.padStart,
			savedEnd = String.prototype.padEnd;
		try {
			rows.push(
				range(
					"xaby",
					7,
					{
						toString() {
							events.push("replace");
							String.prototype.padStart = () => "changed";
							collectGarbage();
							return "_";
						},
					},
					false,
				),
			);
			rows.push(range("xaby", 7, "_", false));
			String.prototype.padStart = String.prototype.padEnd;
			rows.push(range("xaby", 5, "_", false));
			Object.defineProperty(String.prototype, "padStart", {
				configurable: true,
				get() {
					events.push("get");
					return function (n, f) {
						events.push(String(this), n, f);
						collectGarbage();
						return "getter";
					};
				},
			});
			rows.push(range("xaby", 5, "_", false));
		} finally {
			Object.defineProperty(String.prototype, "padStart", {
				value: savedStart,
				writable: true,
				configurable: true,
			});
			String.prototype.padEnd = savedEnd;
		}
	}
	rows.push(events, effects);
} else throw new Error("unknown pad mode");
console.log(JSON.stringify([mode, rows]));
