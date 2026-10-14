"use strict";
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_REPLACE_MODE ?? "range",
	rows = [],
	events = [];
function observe(value) {
	collect();
	return value;
}
function range(source, search, replacement, escape) {
	const part = source.slice(1, -1);
	const a = part.replace(search, replacement);
	const b = part.replaceAll(search, replacement);
	collect();
	return escape ? [a, b, escape(part), escape(part)] : [a, b];
}
function split(source, search, replacement, escape) {
	const part = source.split("|")[1];
	const a = part.replace(search, replacement);
	const b = part.replaceAll(search, replacement);
	collect();
	return escape ? [a, b, escape(part), escape(part)] : [a, b];
}
function capture(source, search, replacement, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const a = part.replace(search, replacement);
	const b = part.replaceAll(search, replacement);
	collect();
	return escape ? [a, b, escape(part), escape(part)] : [a, b];
}
function nested(source, search, replacement, escape) {
	const parent = source.slice(1, -1);
	const part = parent.trim();
	const a = part.replace(search, replacement);
	const b = part.replaceAll(search, replacement);
	collect();
	return escape ? [a, b, escape(parent), escape(part)] : [a, b];
}
function effect(source, hook) {
	const part = source.slice(1, -1);
	return part.replaceAll(hook(1), hook(2), hook(3), hook(4));
}
function alias(source) {
	const part = source.slice(1, -1);
	return [part.replace(part, "x"), part.replaceAll("a", part)];
}
function missing(source, hook) {
	const part = source.split("|")[1];
	return part.replace(hook(), "x");
}
function optional(source) {
	const part = /\|(a)?b\|/.exec(source)[1];
	return part.replaceAll("a", "x");
}
globalThis.replaceRange = range;
globalThis.replaceSplit = split;
globalThis.replaceCapture = capture;
globalThis.replaceNested = nested;
globalThis.replaceEffect = effect;
globalThis.replaceAlias = alias;
globalThis.replaceMissing = missing;
globalThis.replaceOptional = optional;
if (mode !== "fallback") {
	const visit =
		mode === "range"
			? globalThis.replaceRange
			: mode === "split"
				? globalThis.replaceSplit
				: mode === "regexp"
					? globalThis.replaceCapture
					: globalThis.replaceNested;
	const wrap = (text) =>
		mode === "split" || mode === "regexp" ? "left|" + text + "|right" : "L" + text + "R";
	for (const text of [
		"",
		"ababa",
		"aaaa",
		"éÿa",
		"a😀a",
		"\ud800a\udc00",
		" \taba\ufeff ",
	])
		for (const search of ["", "a", "aba", "x", "😀", "\ud800"])
			for (const replacement of [
				"",
				"!",
				search,
				"$$",
				"$&",
				"$`",
				"$'",
				"[$`][$&][$']",
				"$1-$<x>",
			])
				rows.push(
					visit(wrap(text), search, replacement, replacement === "$&" ? observe : null),
				);
	for (const search of ["L", "R", "left|", "|right", "aR", "a|right"])
		rows.push(visit(wrap("aba"), search, "outside", observe));
	const long = "a".repeat(300) + "b";
	rows.push(visit(wrap(long + long + "a"), long, "X", observe));
	const rope = "a".repeat(1200) + "😀" + "a".repeat(1200);
	rows.push(visit(wrap(rope), "a", "éé", observe));
	rows.push(visit(wrap(rope), "😀", "[$`][$']", null));
} else {
	const visit = globalThis.replaceRange;
	rows.push(
		visit(
			{
				slice() {
					events.push("custom slice");
					collect();
					return "aba";
				},
			},
			"a",
			"!",
			null,
		),
	);
	rows.push(
		visit(
			"LababaR",
			{
				toString() {
					events.push("search");
					collect();
					return "a";
				},
			},
			{
				toString() {
					events.push("replacement");
					collect();
					return "$&!";
				},
			},
			observe,
		),
	);
	rows.push(
		visit(
			"LababaR",
			"a",
			function (match, index, source) {
				events.push([this === undefined, arguments.length, match, index, source]);
				collect();
				return {
					toString() {
						collect();
						return index;
					},
				};
			},
			null,
		),
	);
	rows.push(
		visit(
			"LabR",
			{
				[Symbol.replace](source, replacement) {
					events.push(["protocol", source, replacement]);
					collect();
					return "custom";
				},
			},
			"!",
			null,
		),
	);
	const regexp = {
		get [Symbol.match]() {
			events.push("match");
			return true;
		},
		get flags() {
			events.push("flags");
			return "g";
		},
		get [Symbol.replace]() {
			events.push("replace");
			return function (source, replacement) {
				collect();
				return source + replacement;
			};
		},
	};
	rows.push(visit("LabR", regexp, "!", null));
	for (const search of [undefined, null, 0, true, 1n])
		rows.push(visit("Lundefined null 0 true 1R", search, undefined, null));
	rows.push(globalThis.replaceAlias("LabaR"));
	rows.push(
		globalThis.replaceEffect("LabaR", (i) => {
			events.push(i);
			collect();
			return i === 1
				? "a"
				: i === 2
					? "!"
					: {
							toString() {
								throw new Error("ignored");
							},
						};
		}),
	);
	const marker = { fresh: true };
	for (const action of [
		() =>
			globalThis.replaceEffect("LabaR", (i) => {
				events.push(i);
				if (i === 3) throw marker;
				return "a";
			}),
		() => visit("LabR", Symbol("bad"), "!", null),
		() => visit("LabR", "a", Symbol("bad"), null),
		() =>
			globalThis.replaceMissing("missing", () => {
				events.push("missing arg");
				return "a";
			}),
		() => globalThis.replaceOptional("|b|"),
	]) {
		try {
			action();
			throw new Error("missing throw");
		} catch (e) {
			rows.push(e === marker ? "marker" : e.name);
		}
	}
	if (process.env.SPAN_REPLACE_PRIMORDIALS !== "locked") {
		const original = String.prototype.replaceAll;
		try {
			rows.push(
				globalThis.replaceEffect("LabaR", (i) => {
					if (i === 1) String.prototype.replaceAll = () => "replacement method";
					collect();
					return i === 1 ? "a" : "!";
				}),
			);
			rows.push(globalThis.replaceEffect("LabaR", () => "!"));
		} finally {
			String.prototype.replaceAll = original;
		}
	}
}
console.log(JSON.stringify([rows, events]));
