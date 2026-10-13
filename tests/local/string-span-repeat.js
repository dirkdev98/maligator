"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_REPEAT_MODE;
const rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function summary(output) {
	let sum = 0;
	for (let i = 0; i < output.length; i++)
		sum = (sum + output.charCodeAt(i) * ((i % 31) + 1)) >>> 0;
	return [output.length, sum, output.slice(0, 3), output.slice(-3)];
}
function range(source, count, escape) {
	const part = source.slice(1, -1);
	const output = part.repeat(count);
	collectGarbage();
	if (escape) return [summary(output), observed(part), observed(part)];
	return summary(output);
}
function split(source, count, escape) {
	const part = source.split("|")[1];
	const output = part.repeat(count);
	collectGarbage();
	if (escape) return [summary(output), observed(part), observed(part)];
	return summary(output);
}
function capture(source, count, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const output = part.repeat(count);
	collectGarbage();
	if (escape) return [summary(output), observed(part), observed(part)];
	return summary(output);
}
function nested(source, count, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const output = part.repeat(count);
	collectGarbage();
	if (escape) return [summary(output), observed(parent), observed(part), observed(part)];
	return summary(output);
}
function omitted(source) {
	const part = source.slice(1, -1);
	return part.repeat();
}
function extra(source, count, effect) {
	const part = source.slice(1, -1);
	return part.repeat(count, effect());
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
	for (const text of ["ab", "éÿ", "a😀b", "\ud800", "", " \t12\ufeff "])
		for (const count of [undefined, 0, 1, 2.8, "3", null, true, NaN, -0.5]) {
			const source =
				mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y";
			rows.push(visit(source, count, count === 1));
		}
	for (const count of [-1, Infinity, -Infinity, 1e100]) {
		for (const text of ["", "a"]) {
			try {
				rows.push(
					visit(
						mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y",
						count,
						false,
					),
				);
				if (text !== "" || count !== 1e100) throw new Error("missing repeat RangeError");
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				rows.push("RangeError");
			}
		}
	}
	for (const text of ["ab", "a😀b"])
		rows.push(
			visit(
				mode === "split" || mode === "regexp" ? "x|" + text + "|y" : "x" + text + "y",
				32768,
				false,
			),
		);
	const rope = "a".repeat(40000) + "😀" + "b".repeat(40000);
	rows.push(
		visit(
			mode === "split" || mode === "regexp" ? "x|" + rope + "|y" : "x" + rope + "y",
			2,
			false,
		),
	);
	rows.push(omitted("xaby"));
} else if (mode === "fallback") {
	const events = [];
	const count = {
		valueOf() {
			events.push("count");
			collectGarbage();
			return 2;
		},
	};
	rows.push(range("xaby", count, true));
	for (const value of [1n, Symbol("bad")]) {
		try {
			range("xaby", value, false);
			throw new Error("missing count error");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			events.push("TypeError");
		}
	}
	let result;
	const source = {
		slice() {
			events.push("slice");
			result = {
				repeat(value) {
					events.push(this === result, value);
					collectGarbage();
					return "custom";
				},
			};
			return result;
		},
	};
	rows.push(range(source, 3, false));
	let effects = 0;
	rows.push(
		extra("xaby", 2, () => {
			effects++;
			return {
				valueOf() {
					throw new Error("extra coerced");
				},
			};
		}),
	);
	const marker = { original: true };
	try {
		extra("xaby", 2, () => {
			effects++;
			throw marker;
		});
		throw new Error("missing extra error");
	} catch (error) {
		if (error !== marker) throw error;
	}
	if (effects !== 2) throw new Error("extra arguments replayed");
	if (process.env.SPAN_REPEAT_PRIMORDIALS === "mutable") {
		const saved = String.prototype.repeat;
		try {
			rows.push(
				range(
					"xaby",
					{
						valueOf() {
							events.push("replace");
							String.prototype.repeat = () => "changed";
							collectGarbage();
							return 2;
						},
					},
					false,
				),
			);
			rows.push(range("xaby", 2, false));
			String.prototype.repeat = String.prototype.slice;
			rows.push(range("xaby", 1, false));
			Object.defineProperty(String.prototype, "repeat", {
				configurable: true,
				get() {
					events.push("get");
					return function (n) {
						events.push(String(this), n);
						collectGarbage();
						return "getter";
					};
				},
			});
			rows.push(range("xaby", 2, false));
		} finally {
			Object.defineProperty(String.prototype, "repeat", {
				value: saved,
				writable: true,
				configurable: true,
			});
		}
	}
	rows.push(events, effects);
} else throw new Error("unknown repeat mode");
console.log(JSON.stringify([mode, rows]));
