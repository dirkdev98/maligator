"use strict";
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_SEARCH_MODE ?? "range",
	rows = [],
	events = [];
function observe(value) {
	collect();
	return value;
}
function range(source, needle, position, escape) {
	const part = source.slice(1, -1);
	const out = [
		part.indexOf(needle, position),
		part.lastIndexOf(needle, position),
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function split(source, needle, position, escape) {
	const part = source.split("|")[1];
	const out = [
		part.indexOf(needle, position),
		part.lastIndexOf(needle, position),
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function capture(source, needle, position, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const out = [
		part.indexOf(needle, position),
		part.lastIndexOf(needle, position),
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
	collect();
	return escape ? [out, escape(part), escape(part)] : out;
}
function nested(source, needle, position, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const out = [
		part.indexOf(needle, position),
		part.lastIndexOf(needle, position),
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
	collect();
	return escape ? [out, escape(parent), escape(part)] : out;
}
function effect(source, hook) {
	const part = source.slice(1, -1);
	return part.includes(hook(1), hook(2));
}
function alias(source) {
	const part = source.slice(1, -1);
	return part.indexOf(part);
}
function missing(source, hook) {
	const part = source.split("|")[1];
	return part.indexOf(hook());
}
function optional(source) {
	const part = /\|(a)?b\|/.exec(source)[1];
	return part.includes(1);
}
function omitted(source, needle) {
	const part = source.slice(1, -1);
	return [
		part.indexOf(needle),
		part.lastIndexOf(needle),
		part.includes(needle),
		part.startsWith(needle),
		part.endsWith(needle),
	];
}
function absent(source) {
	const part = source.slice(1, -1);
	return [
		part.indexOf(),
		part.lastIndexOf(),
		part.includes(),
		part.startsWith(),
		part.endsWith(),
	];
}
globalThis.searchRange = range;
globalThis.searchSplit = split;
globalThis.searchCapture = capture;
globalThis.searchNested = nested;
globalThis.searchEffect = effect;
globalThis.searchAlias = alias;
globalThis.searchMissing = missing;
globalThis.searchOptional = optional;
globalThis.searchAbsent = absent;
globalThis.searchOmitted = omitted;
if (mode !== "fallback") {
	const visit =
		mode === "range"
			? globalThis.searchRange
			: mode === "split"
				? globalThis.searchSplit
				: mode === "regexp"
					? globalThis.searchCapture
					: globalThis.searchNested;
	const wrap = (text) =>
		mode === "split" || mode === "regexp" ? "left|" + text + "|right" : "L" + text + "R";
	for (const needle of [
		undefined,
		null,
		false,
		true,
		0,
		-0,
		1.25,
		-1.25,
		NaN,
		Infinity,
		-Infinity,
		1e21,
		1e-7,
		0n,
		1234567890123456789012345678901234567890n,
	]) {
		const text = String(needle);
		for (const position of [
			undefined,
			null,
			false,
			true,
			"",
			" 1.5 ",
			NaN,
			0,
			-0,
			Infinity,
			-Infinity,
			-2,
			2.8,
		])
			rows.push(
				visit(
					wrap(text + "😀" + text),
					needle,
					position,
					position === true ? observe : null,
				),
			);
		rows.push(visit(wrap(""), needle, undefined, null));
	}
	const huge = BigInt("7".repeat(350));
	rows.push(
		visit(
			wrap("x".repeat(1200) + String(huge) + "y".repeat(1200) + String(huge)),
			huge,
			0,
			observe,
		),
	);
	rows.push(visit(wrap("suffix"), 7, 0, null));
} else {
	const visit = globalThis.searchRange;
	rows.push(globalThis.searchAbsent("LundefinedR"));
	rows.push(globalThis.searchOmitted("LundefinedR", undefined));
	rows.push(globalThis.searchOmitted("L1212R", 12));
	rows.push(
		visit(
			"L12😀12R",
			{
				get [Symbol.match]() {
					events.push("match");
					collect();
					return false;
				},
				toString() {
					events.push("needle");
					collect();
					return "12";
				},
			},
			{
				valueOf() {
					events.push("position");
					collect();
					return 1;
				},
			},
			observe,
		),
	);
	rows.push(
		visit(
			{
				slice() {
					events.push("source");
					collect();
					return "false false";
				},
			},
			false,
			0,
			null,
		),
	);
	rows.push(globalThis.searchAlias("LabaR"));
	rows.push(
		globalThis.searchEffect("L12R", (i) => {
			events.push(i);
			collect();
			return i === 1 ? 12 : 0;
		}),
	);
	const marker = { original: true };
	for (const action of [
		() => visit("L12R", Symbol("needle"), 0, null),
		() => visit("L12R", 12, Symbol("position"), null),
		() => visit("L12R", 12, 0n, null),
		() =>
			visit(
				"L12R",
				{
					toString() {
						events.push("throw needle");
						throw marker;
					},
				},
				{
					valueOf() {
						events.push("must not run");
						return 0;
					},
				},
				null,
			),
		() =>
			globalThis.searchMissing("absent", () => {
				events.push("missing arg");
				return 1;
			}),
		() => globalThis.searchOptional("|b|"),
		() =>
			globalThis.searchEffect("L12R", (i) => {
				events.push(i);
				if (i === 2) throw marker;
				return 12;
			}),
	]) {
		try {
			action();
			throw new Error("missing throw");
		} catch (e) {
			rows.push(e === marker ? "marker" : e.name);
		}
	}
	for (const method of ["includes", "startsWith", "endsWith"]) {
		const search = {
			get [Symbol.match]() {
				events.push(method + " match");
				collect();
				return true;
			},
			toString() {
				throw new Error("must not coerce regexp");
			},
		};
		try {
			"12"[method](search, {
				valueOf() {
					throw new Error("must not read position");
				},
			});
			throw new Error("missing regexp error");
		} catch (e) {
			rows.push(e.name);
		}
	}
	if (process.env.SPAN_SEARCH_PRIMORDIALS !== "locked") {
		const original = String.prototype.includes;
		try {
			rows.push(
				globalThis.searchEffect("L12R", (i) => {
					if (i === 1) String.prototype.includes = () => "new method";
					collect();
					return i === 1 ? 12 : 0;
				}),
			);
			rows.push(globalThis.searchEffect("L12R", () => 0));
		} finally {
			String.prototype.includes = original;
		}
	}
}
console.log(JSON.stringify([rows, events]));
