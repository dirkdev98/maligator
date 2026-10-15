"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_LOCALE_CASE_MODE,
	rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function range(source, locales, escape) {
	const part = source.slice(1, -1),
		lower = part.toLocaleLowerCase(locales),
		upper = part.toLocaleUpperCase(locales);
	collectGarbage();
	return escape ? [lower, upper, observed(part), observed(part)] : [lower, upper];
}
function split(source, locales, escape) {
	const part = source.split("|")[1],
		lower = part.toLocaleLowerCase(locales),
		upper = part.toLocaleUpperCase(locales);
	collectGarbage();
	return escape ? [lower, upper, observed(part), observed(part)] : [lower, upper];
}
function capture(source, locales, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1],
		lower = part.toLocaleLowerCase(locales),
		upper = part.toLocaleUpperCase(locales);
	collectGarbage();
	return escape ? [lower, upper, observed(part), observed(part)] : [lower, upper];
}
function nested(source, locales, escape) {
	const parent = source.slice(1, -1),
		part = parent.trim(),
		lower = part.toLocaleLowerCase(locales),
		upper = part.toLocaleUpperCase(locales);
	collectGarbage();
	return escape ? [lower, upper, observed(parent), observed(part)] : [lower, upper];
}
function extra(source, locales, effect) {
	const part = source.slice(1, -1);
	return [
		part.toLocaleLowerCase(locales, effect(), Symbol("ignored")),
		part.toLocaleUpperCase(locales, effect(), 12n),
	];
}
function omitted(source) {
	const part = source.slice(1, -1);
	return [part.toLocaleLowerCase(), part.toLocaleUpperCase()];
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
		mode === "split" || mode === "regexp" ? "A|" + text + "|A" : "A" + text + "A";
	for (const text of [
		"",
		"ASCII",
		"Iİiı",
		"I\u0307",
		"I\u0301",
		"J\u0300",
		"i\u0307",
		"\u012e\u0301",
		"Σ",
		"ΟΣ",
		"ΟΣΑ",
		"ßµÿ",
		"\ud800i\udfff",
		" \tI\ufeff ",
	])
		for (const locale of ["en", "tr", "az", "lt"])
			rows.push(visit(source(text), locale, locale === "lt"));
	const events = [];
	const locales = new Proxy(
		{
			get length() {
				events.push("length");
				collectGarbage();
				return 1;
			},
			get 0() {
				events.push("zero");
				collectGarbage();
				return {
					toString() {
						events.push("tag");
						collectGarbage();
						rows.push("I".toLocaleLowerCase("en"));
						return "TR";
					},
				};
			},
			get 2() {
				events.push("two");
				collectGarbage();
				return "az";
			},
			get [Symbol.iterator]() {
				throw new Error("locale iterator must not be read");
			},
		},
		{
			has(target, key) {
				events.push("has:" + String(key));
				return key in target;
			},
		},
	);
	rows.push(visit(source("Iİ"), locales, true), events);
	const longTag = "tr-x-abcdefgh-ijklmnop-qrstuvwx-yzabcdef";
	rows.push(visit(source("I\u0307İ"), longTag, false));
	const rope = "I\u0307".repeat(160) + "Σ" + "i\u0307".repeat(160);
	rows.push(visit(source(rope), "tr", false), visit(source(rope), "lt", false));
	if (mode === "range") {
		rows.push(
			range("xI\u0307", "tr", true),
			range("I\u0307x", "tr", true),
			range("i\u0307x", "lt", true),
			range("AΣA", "en", true),
		);
		rows.push(range("xiY", new Intl.Locale("tr"), false), omitted("xAsciiY"));
		rows.push(
			extra("xIY", "tr", () => {
				collectGarbage();
				return {
					toString() {
						throw new Error("ignored extra coercion");
					},
				};
			}),
		);
	}
} else if (mode === "locale-list") {
	const events = [];
	const locales = new Proxy(
		{
			get length() {
				events.push("length");
				collectGarbage();
				return {
					valueOf() {
						events.push("length number");
						collectGarbage();
						return 3;
					},
				};
			},
			get 0() {
				events.push("zero");
				collectGarbage();
				return {
					toString() {
						events.push("tag");
						collectGarbage();
						return "tr";
					},
				};
			},
			get 2() {
				events.push("two");
				collectGarbage();
				return "az";
			},
			get [Symbol.iterator]() {
				throw new Error("unexpected iterator");
			},
		},
		{
			has(target, key) {
				events.push("has:" + String(key));
				return key in target;
			},
		},
	);
	// A callable proxy preserves the span path when locked calls inline through Reflect.apply.
	const result = Reflect.apply(new Proxy(extra, {}), undefined, [
		"xIY",
		locales,
		() => {
			events.push("extra");
			collectGarbage();
		},
	]);
	const once = "extra,length,length number,has:0,zero,tag,has:1,has:2,two";
	if (result[0] !== "ı" || result[1] !== "I" || events.join() !== once + "," + once)
		throw new Error("locale list observation");
	let thrown = 0;
	for (const method of [
		String.prototype.toLocaleLowerCase,
		String.prototype.toLocaleUpperCase,
	]) {
		for (const text of ["", "123"]) {
			try {
				method.call(text, ["tr", "bad_tag"]);
			} catch (e) {
				if (!(e instanceof RangeError)) throw e;
				thrown++;
			}
		}
	}
	if (thrown !== 4) throw new Error("later invalid locale ignored");
	rows.push("locale lists PASS");
} else if (mode === "fallback") {
	const events = [];
	for (const locale of ["", "not_a_tag", null, [1], [Symbol("bad")]]) {
		for (const source of ["xy", "x123y"]) {
			try {
				range(source, locale, false);
				throw new Error("missing locale error");
			} catch (e) {
				if (!(e instanceof RangeError) && !(e instanceof TypeError)) throw e;
				events.push(e.name);
			}
		}
	}
	const original = { original: true };
	for (const locales of [
		{
			get length() {
				collectGarbage();
				throw original;
			},
		},
		{
			length: 1,
			get 0() {
				collectGarbage();
				throw original;
			},
		},
		{
			length: 1,
			0: {
				toString() {
					collectGarbage();
					throw original;
				},
			},
		},
	]) {
		try {
			range("xy", locales, false);
			throw new Error("missing original");
		} catch (e) {
			if (e !== original) throw e;
			events.push("original");
		}
	}
	const receiver = {
		toLocaleLowerCase: String.prototype.toLocaleLowerCase,
		toLocaleUpperCase: String.prototype.toLocaleUpperCase,
		[Symbol.toPrimitive](hint) {
			events.push("receiver:" + hint);
			collectGarbage();
			return "I";
		},
	};
	const locales = {
		get length() {
			events.push("locales");
			collectGarbage();
			return 1;
		},
		0: "tr",
	};
	rows.push(
		extra(
			{
				slice() {
					events.push("slice");
					return receiver;
				},
			},
			locales,
			() => {
				events.push("extra");
				return Symbol("ignored");
			},
		),
	);
	if (
		events.slice(-7).join() !==
		"slice,extra,receiver:string,locales,extra,receiver:string,locales"
	)
		throw new Error("conversion order");
	let token;
	rows.push(
		extra(
			{
				slice() {
					return (token = {
						toLocaleLowerCase(...args) {
							events.push(this === token, args.length);
							return "lower";
						},
						toLocaleUpperCase(...args) {
							events.push(this === token, args.length);
							return "upper";
						},
					});
				},
			},
			null,
			() => {},
		),
	);
	try {
		extra("xIY", "tr", () => {
			throw original;
		});
		throw new Error("missing argument error");
	} catch (e) {
		if (e !== original) throw e;
		events.push("argument");
	}
	if (process.env.SPAN_LOCALE_CASE_PRIMORDIALS !== "locked") {
		const lower = String.prototype.toLocaleLowerCase,
			upper = String.prototype.toLocaleUpperCase;
		try {
			let gets = 0;
			rows.push(
				range(
					"xIY",
					{
						get length() {
							if (gets++ === 0)
								String.prototype.toLocaleLowerCase = () => "changed lower";
							else String.prototype.toLocaleUpperCase = () => "changed upper";
							collectGarbage();
							return 1;
						},
						0: "tr",
					},
					true,
				),
			);
			rows.push(range("xIY", "tr", false));
			String.prototype.toLocaleLowerCase = upper;
			String.prototype.toLocaleUpperCase = lower;
			rows.push(range("xIY", "tr", false));
		} finally {
			String.prototype.toLocaleLowerCase = lower;
			String.prototype.toLocaleUpperCase = upper;
		}
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
