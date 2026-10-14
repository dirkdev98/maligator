"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.SPAN_WELL_FORMED_MODE,
	rows = [];
function observed(part) {
	collectGarbage();
	return `observed:${part}`;
}
function range(source, escape) {
	const part = source.slice(1, -1);
	const valid = part.isWellFormed(),
		result = part.toWellFormed();
	collectGarbage();
	return escape ? [valid, result, observed(part), observed(part)] : [valid, result];
}
function split(source, escape) {
	const part = source.split("|")[1];
	const valid = part.isWellFormed(),
		result = part.toWellFormed();
	collectGarbage();
	return escape ? [valid, result, observed(part), observed(part)] : [valid, result];
}
function capture(source, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const valid = part.isWellFormed(),
		result = part.toWellFormed();
	collectGarbage();
	return escape ? [valid, result, observed(part), observed(part)] : [valid, result];
}
function nested(source, escape) {
	const parent = source.slice(1, -1),
		part = parent.trim();
	const valid = part.isWellFormed(),
		result = part.toWellFormed();
	collectGarbage();
	return escape ? [valid, result, observed(parent), observed(part)] : [valid, result];
}
function extra(source, effect) {
	const part = source.slice(1, -1);
	return [
		part.isWellFormed(effect(), Symbol("ignored"), 1n),
		part.toWellFormed(effect(), null, undefined),
	];
}
function makeRope(length) {
	return "a".repeat(length) + "\ud800" + ("\udc00" + "z".repeat(length));
}
globalThis.makeWellFormedRope = makeRope;
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
			? "\ud800|" + text + "|\udc00"
			: "\ud800" + text + "\udc00";
	for (const text of [
		"",
		"ASCII",
		"é",
		"Ā",
		"\uffff",
		"\ud800",
		"\udc00",
		"\ud800\udc00",
		"\udc00\ud800",
		"\ud800a\udc00",
		"\ud800\ud800\udc00\udc00",
		"\ud800é\udc00",
		"\ud800Ā\udc00",
		" \t\ud800\udc00\ufeff ",
		"\ud800\udc00\ud800\udc00",
	]) {
		rows.push(visit(source(text), false), visit(source(text), true));
	}
	const rope = globalThis.makeWellFormedRope(300);
	rows.push(
		visit(source(rope), false),
		visit(source(rope + "\ud800"), true),
		visit(source("\udc00" + rope), false),
	);
	const deep = Array.from({ length: 80 }, (_, i) =>
		i % 3 === 0 ? "\ud800" : i % 3 === 1 ? "\udc00" : "é",
	).join("");
	rows.push(visit(source(deep), true));
	if (mode === "range") {
		rows.push(range("X\ud800\udc00", true), range("\ud800\udc00X", true));
		const events = [];
		rows.push(
			extra("X\ud800Y", () => {
				events.push("extra");
				collectGarbage();
				return {
					toString() {
						throw new Error("ignored coercion");
					},
				};
			}),
			events,
		);
	}
} else if (mode === "fallback") {
	const events = [];
	const receiver = {
		isWellFormed: String.prototype.isWellFormed,
		toWellFormed: String.prototype.toWellFormed,
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			collectGarbage();
			return "\ud800A\udc00";
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
			false,
		),
		events.slice(),
	);
	if (events.join() !== "slice,string,string")
		throw new Error("receiver conversion order");
	let token;
	rows.push(
		extra(
			{
				slice() {
					return (token = {
						isWellFormed(...args) {
							events.push(this === token, args.length);
							return "check";
						},
						toWellFormed(...args) {
							events.push(this === token, args.length);
							return "repair";
						},
					});
				},
			},
			() => {
				events.push("extra");
				return Symbol("ignored");
			},
		),
	);
	const original = { original: true };
	try {
		extra("X\ud800Y", () => {
			collectGarbage();
			throw original;
		});
		throw new Error("missing argument throw");
	} catch (e) {
		if (e !== original) throw e;
		events.push("original");
	}
	for (const method of ["isWellFormed", "toWellFormed"]) {
		for (const value of [null, undefined, Symbol("bad")]) {
			try {
				String.prototype[method].call(value);
				throw new Error("missing receiver error");
			} catch (e) {
				if (!(e instanceof TypeError)) throw e;
				events.push(e.name);
			}
		}
	}
	try {
		capture("no match", false);
		throw new Error("missing capture");
	} catch (e) {
		if (!(e instanceof TypeError)) throw e;
		events.push("missing capture");
	}
	if (process.env.SPAN_WELL_FORMED_PRIMORDIALS !== "locked") {
		const savedCheck = String.prototype.isWellFormed,
			savedRepair = String.prototype.toWellFormed;
		try {
			let calls = 0;
			rows.push(
				extra("X\ud800Y", () => {
					collectGarbage();
					if (calls++ === 0) String.prototype.isWellFormed = () => "changed check";
					else String.prototype.toWellFormed = () => "changed repair";
				}),
			);
			rows.push(range("X\ud800Y", false));
			String.prototype.isWellFormed = savedRepair;
			String.prototype.toWellFormed = savedCheck;
			rows.push(range("X\ud800Y", false));
		} finally {
			String.prototype.isWellFormed = savedCheck;
			String.prototype.toWellFormed = savedRepair;
		}
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
