"use strict";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
const mode = process.env.TRIM_ALIAS_MODE;
const rows = [];
function observed(value) {
	collectGarbage();
	return `observed:${value}`;
}
let effects = 0;
function argument(index, effect) {
	effects++;
	if (effect) effect(index);
	return index === 0
		? Symbol("ignored")
		: index === 1
			? 1n
			: {
					valueOf() {
						throw new Error("ignored argument coerced");
					},
				};
}
function left(source, effect, escape) {
	const part = source.trimLeft(
		argument(0, effect),
		argument(1, effect),
		argument(2, effect),
		argument(3, effect),
	);
	const length = part.length;
	collectGarbage();
	if (escape) return [length, observed(part), observed(part)];
	return [length, part.charAt(0), part.at(-1), Number(part)];
}
function right(source, effect, escape) {
	const part = source.trimRight(
		argument(0, effect),
		argument(1, effect),
		argument(2, effect),
		argument(3, effect),
	);
	const length = part.length;
	collectGarbage();
	if (escape) return [length, observed(part), observed(part)];
	return [length, part.charAt(0), part.at(-1), Number(part)];
}
function canonical(source, effect) {
	const part = source.trim(
		argument(0, effect),
		argument(1, effect),
		argument(2, effect),
		argument(3, effect),
	);
	collectGarbage();
	return [part.length, part === "12", Number(part)];
}
function nested(source, escape) {
	const parent = source.slice(1, -1);
	const child = parent.trimLeft(argument(0), argument(1), argument(2));
	const leaf = child.trimRight();
	collectGarbage();
	if (escape) return [observed(parent), observed(child), observed(leaf), observed(leaf)];
	return [leaf.length, leaf.at(-1), leaf.includes("2"), parent.length];
}
function split(source, escape) {
	const parent = source.split("|")[1];
	const child = parent.trimLeft();
	const leaf = child.trimRight();
	collectGarbage();
	if (escape) return [observed(parent), observed(child), observed(leaf)];
	return [leaf.length, leaf.at(-1), parent.length];
}
function capture(source, escape) {
	const parent = /\|([^|]*)\|/.exec(source)[1];
	const child = parent.trimRight();
	const leaf = child.trimLeft();
	collectGarbage();
	if (escape) return [observed(parent), observed(child), observed(leaf)];
	return [leaf.length, leaf.codePointAt(0), parent.length];
}
if (mode === "left" || mode === "right" || mode === "many") {
	const visit = mode === "left" ? left : mode === "right" ? right : canonical;
	for (const text of [
		" \t12\ufeff ",
		"\u2029😀\u3000",
		" \ud800 ",
		"\u200b12\u180e",
		"\t\n",
		"",
	])
		for (const escape of [false, true]) rows.push(visit(text, undefined, escape));
	if (effects !== 48) throw new Error("argument evaluation count");
} else if (mode === "nested") {
	for (const text of [" \t12\ufeff ", "\u2029😀\u3000", " \ud800 ", "\t\n", ""])
		for (const escape of [false, true])
			rows.push(
				nested("x" + text + "y", escape),
				split("x|" + text + "|y", escape),
				capture("x|" + text + "|y", escape),
			);
} else if (mode === "fallback") {
	const observed = [];
	const custom = {
		trimLeft(...args) {
			observed.push(this === custom, args.length, typeof args[0], typeof args[1]);
			collectGarbage();
			return "custom";
		},
		trimRight: String.prototype.trimRight,
		toString() {
			observed.push("coerced");
			collectGarbage();
			return " 12 ";
		},
	};
	rows.push(left(custom, undefined, true), right(custom, undefined, true));
	const marker = { original: true };
	try {
		left(
			" 12 ",
			(index) => {
				if (index === 2) throw marker;
			},
			false,
		);
		throw new Error("missing argument error");
	} catch (error) {
		if (error !== marker) throw error;
	}
	rows.push(observed, effects);
	if (effects !== 11) throw new Error("argument exception replayed");
	if (process.env.TRIM_ALIAS_PRIMORDIALS === "mutable") {
		const savedLeft = String.prototype.trimLeft,
			savedRight = String.prototype.trimRight;
		try {
			String.prototype.trimLeft = String.prototype.trimEnd;
			rows.push(left(" 12 ", undefined, true));
			String.prototype.trimLeft = String.prototype.slice;
			const before = effects;
			try {
				left(" 12 ", undefined, false);
				throw new Error("wrong builtin accepted");
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
			}
			if (effects !== before + 4) throw new Error("wrong builtin replayed arguments");
			String.prototype.trimLeft = savedLeft;
			rows.push(
				left(
					" 12 ",
					(index) => {
						if (index === 3) String.prototype.trimLeft = () => "replacement";
					},
					true,
				),
			);
			rows.push(left(" 12 ", undefined, true));
			String.prototype.trimLeft = savedLeft;
			Object.defineProperty(String.prototype, "trimRight", {
				configurable: true,
				get() {
					observed.push("get");
					return function (...args) {
						observed.push(args.length);
						collectGarbage();
						return "getter";
					};
				},
			});
			rows.push(right(" 12 ", undefined, true));
		} finally {
			Object.defineProperty(String.prototype, "trimLeft", {
				value: savedLeft,
				writable: true,
				configurable: true,
			});
			Object.defineProperty(String.prototype, "trimRight", {
				value: savedRight,
				writable: true,
				configurable: true,
			});
		}
	}
} else throw new Error("unknown trim alias mode");
console.log(JSON.stringify([mode, rows, effects]));
