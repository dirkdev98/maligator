"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_NORMALIZE_MODE,
	rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function range(source, form, escape) {
	const part = source.slice(1, -1);
	const result = part.normalize(form);
	collectGarbage();
	if (escape) return [result, observed(part), observed(part)];
	return result;
}
function split(source, form, escape) {
	const part = source.split("|")[1];
	const result = part.normalize(form);
	collectGarbage();
	if (escape) return [result, observed(part), observed(part)];
	return result;
}
function capture(source, form, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const result = part.normalize(form);
	collectGarbage();
	if (escape) return [result, observed(part), observed(part)];
	return result;
}
function nested(source, form, escape) {
	const parent = source.slice(1, -1),
		part = parent.trim();
	const result = part.normalize(form);
	collectGarbage();
	if (escape) return [result, observed(parent), observed(part)];
	return result;
}
function extra(source, form, effect) {
	const part = source.slice(1, -1);
	return part.normalize(form, effect(), Symbol("ignored"), 12n);
}
function omitted(source) {
	const part = source.slice(1, -1);
	return part.normalize();
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
		mode === "split" || mode === "regexp"
			? "A|" + text + "|\u030a"
			: "A" + text + "\u030a";
	for (const text of [
		"",
		"ASCII",
		"é",
		"e\u0301",
		"\u212b",
		"\ufb03",
		"\u1e0a\u0323",
		"\u1100\u1161\u11a8",
		"\u0958",
		"\u030aA",
		"A",
		"\ud800A\u030a\udfff",
		"\ud834\udd5e",
		" \té\ufeff ",
	])
		for (const form of [undefined, "NFC", "NFD", "NFKC", "NFKD"])
			rows.push(visit(source(text), form, form === "NFD"));
	const events = [];
	const form = {
		get [Symbol.toPrimitive]() {
			events.push("form get");
			collectGarbage();
			return (hint) => {
				events.push(hint);
				collectGarbage();
				rows.push(String.prototype.normalize.call("\ufb03", "NFKC"));
				return "NFD";
			};
		},
	};
	rows.push(visit(source("é"), form, true), events);
	const rope = "A\u030aé".repeat(180) + "\u1e0a\u0323" + "e\u0301".repeat(180);
	rows.push(visit(source(rope), "NFC", false));
	rows.push(visit(source("a" + "\u0301".repeat(40) + "\u0323".repeat(40)), "NFC", false));
	if (mode === "range") {
		rows.push(
			range("\ud834\udd5eX", "NFD", true),
			range("X\ud834\udd5e", "NFD", true),
			range("ĀéĀ", "NFC", true),
		);
		rows.push(
			omitted("xe\u0301y"),
			extra("xéy", "NFD", () => {
				collectGarbage();
				return {
					toString() {
						throw new Error("ignored extra");
					},
				};
			}),
		);
	}
} else if (mode === "fallback") {
	const events = [];
	for (const form of ["", "nfc", null, false, 12, 12n, Symbol("bad")])
		for (const source of ["xy", "xASCIIy"]) {
			try {
				range(source, form, false);
				throw new Error("missing invalid form");
			} catch (e) {
				const Expected = typeof form === "symbol" ? TypeError : RangeError;
				if (!(e instanceof Expected)) throw e;
				events.push(e.name);
			}
		}
	const original = { original: true };
	try {
		range(
			"xy",
			{
				toString() {
					collectGarbage();
					throw original;
				},
			},
			false,
		);
		throw new Error("missing original");
	} catch (e) {
		if (e !== original) throw e;
		events.push("original");
	}
	try {
		extra("xéy", "NFD", () => {
			events.push("argument");
			throw original;
		});
		throw new Error("missing argument");
	} catch (e) {
		if (e !== original) throw e;
	}
	const receiver = {
		normalize: String.prototype.normalize,
		[Symbol.toPrimitive]() {
			events.push("receiver");
			collectGarbage();
			return "e\u0301";
		},
	};
	const form = {
		toString() {
			events.push("form");
			collectGarbage();
			return "NFC";
		},
	};
	rows.push(
		range(
			{
				slice() {
					events.push("slice");
					return receiver;
				},
			},
			form,
			false,
		),
	);
	if (events.slice(-3).join() !== "slice,receiver,form")
		throw new Error("coercion order");
	let token;
	rows.push(
		extra(
			{
				slice() {
					return (token = {
						normalize(...args) {
							events.push(this === token, args.length);
							return "custom";
						},
					});
				},
			},
			form,
			() => {
				events.push("extra");
				return Symbol("unused");
			},
		),
	);
	if (process.env.SPAN_NORMALIZE_PRIMORDIALS !== "locked") {
		const saved = String.prototype.normalize;
		try {
			rows.push(
				range(
					"xéy",
					{
						toString() {
							events.push("captured");
							String.prototype.normalize = () => "changed";
							collectGarbage();
							return "NFD";
						},
					},
					true,
				),
			);
			rows.push(range("xéy", "NFD", false));
			String.prototype.normalize = saved;
			rows.push(
				extra("xéy", "NFD", () => {
					String.prototype.normalize = String.prototype.repeat;
					collectGarbage();
				}),
			);
			try {
				range("xéy", Symbol("bad"), false);
				throw new Error("missing repeat error");
			} catch (e) {
				if (!(e instanceof TypeError)) throw e;
				events.push("wrong method");
			}
		} finally {
			String.prototype.normalize = saved;
		}
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
