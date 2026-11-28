"use strict";
// Each helper calls a method on a receiver it cannot see, so the call site guesses the
// builtin from its name and keeps the ordinary call for every other receiver.
const lower = (value) => value.toLowerCase();
const upper = (value) => value.toUpperCase();
const indexOf = (value, ...args) => value.indexOf(...args.slice(0, 2));
const find = (value, search) => value.indexOf(search);
const findFrom = (value, search, position) => value.indexOf(search, position);
const findLast = (value, search, position) => value.lastIndexOf(search, position);
const has = (value, search) => value.includes(search);
const starts = (value, search, position) => value.startsWith(search, position);
const ends = (value, search, position) => value.endsWith(search, position);
const cut = (value, start, end) => value.slice(start, end);
const cutFrom = (value, start) => value.slice(start);
const sub = (value, start, end) => value.substring(start, end);
const substr = (value, start, length) => value.substr(start, length);
const exec = (regexp, input) => regexp.exec(input);
const read = (store, key) => store.get(key);
const write = (store, key, value) => store.set(key, value);
const holds = (store, key) => store.has(key);

const lines = [];
function show(label, run) {
	try {
		const value = run();
		lines.push(`${label}: ${typeof value} ${JSON.stringify(value)}`);
	} catch (error) {
		lines.push(`${label}: threw ${error.constructor.name}`);
	}
}

const log = [];
const position = {
	valueOf() {
		log.push("position");
		return 1;
	},
};
const needle = {
	toString() {
		log.push("needle");
		return "b";
	},
};
const lookalike = {
	toLowerCase: () => "own toLowerCase",
	toUpperCase: () => "own toUpperCase",
	indexOf: () => "own indexOf",
	lastIndexOf: () => "own lastIndexOf",
	includes: () => "own includes",
	startsWith: () => "own startsWith",
	endsWith: () => "own endsWith",
	slice: () => "own slice",
	substring: () => "own substring",
	substr: () => "own substr",
	exec: () => "own exec",
};

for (let round = 0; round < 3; round++) {
	show("lower string", () => lower("Content-Type"));
	show("lower non-ascii", () => lower("ÀÉÎ İ"));
	show("upper string", () => upper("straße"));
	show("lower built string", () => lower(`X-Round-${round}`));
	show("lower String object", () => lower(new String("ABC")));
	show("lower lookalike", () => lower(lookalike));
	show("lower number", () => lower(12));
	show("upper lookalike", () => upper(lookalike));
	show("upper null receiver", () => upper(null));
	show("indexOf string", () => find("text/html", "/"));
	show("indexOf missing", () => find("text", "/"));
	show("indexOf array", () => find(["a", "/", "b"], "/"));
	show("indexOf array string", () => find("a/b", "/"));
	show("indexOf number needle", () => find("a1b2", 2));
	show("indexOf position", () => findFrom("abcabc", "b", 2));
	show("indexOf NaN position", () => findFrom("abcabc", "b", NaN));
	show("indexOf object position", () => findFrom("abcabc", "b", position));
	show("indexOf object needle", () => find("abc", needle));
	show("indexOf symbol needle", () => find("abc", Symbol("b")));
	show("indexOf no arguments", () => indexOf("undefined!"));
	show("indexOf lookalike", () => find(lookalike, "x"));
	show("lastIndexOf", () => findLast("abcabc", "b"));
	show("lastIndexOf position", () => findLast("abcabc", "b", 3));
	show("lastIndexOf array", () => findLast([1, 2, 1], 1));
	show("lastIndexOf lookalike", () => findLast(lookalike, "x"));
	show("lastIndexOf undefined receiver", () => findLast(undefined, "x"));
	show("indexOf null receiver", () => find(null, "x"));
	show("includes string", () => has("abc", "c"));
	show("includes array", () => has([1, 2, 3], 2));
	show("includes regexp", () => has("abc", /b/));
	show("includes object needle", () => has("abc", needle));
	show("includes lookalike", () => has(lookalike, "x"));
	show("includes null receiver", () => has(null, "x"));
	show("startsWith", () => starts("abc", "b", 1));
	show("startsWith regexp", () => starts("abc", /a/));
	show("startsWith object position", () => starts("abc", "b", position));
	show("startsWith lookalike", () => starts(lookalike, "x"));
	show("startsWith undefined receiver", () => starts(undefined, "x"));
	show("endsWith", () => ends("abc", "b", 2));
	show("endsWith lookalike", () => ends(lookalike, "x"));
	show("endsWith null receiver", () => ends(null, "x"));
	show("slice", () => cut("Content-Type", 0, 7));
	show("slice negative", () => cut("Content-Type", -4));
	show("slice from", () => cutFrom("abcdef", 2));
	show("slice NaN", () => cut("abcdef", NaN, 3));
	show("slice string positions", () => cut("abcdef", "1", "3"));
	show("slice object position", () => cut("abcdef", position));
	show("slice array", () => cutFrom([1, 2, 3], 1));
	show("slice String object", () => cut(new String("abcdef"), 1, 3));
	show("slice lookalike", () => cut(lookalike, 1, 2));
	show("substring swapped", () => sub("abcdef", 4, 1));
	show("substring infinite", () => sub("abcdef", 2, Infinity));
	show("substring object position", () => sub("abcdef", position, 4));
	show("substring lookalike", () => sub(lookalike, 1, 2));
	show("substring undefined receiver", () => sub(undefined, 1, 2));
	show("substr", () => substr("abcdef", -3, 2));
	show("substr open", () => substr("abcdef", 2));
	show("substr lookalike", () => substr(lookalike, 1, 2));
	show("substr null receiver", () => substr(null, 1));
	show("slice null receiver", () => cut(null, 1));
	show("lower undefined receiver", () => lower(undefined));

	const global = /a(\d)/g;
	show("exec global 1", () => exec(global, "a1 a2"));
	show("exec global lastIndex", () => global.lastIndex);
	show("exec global 2", () => exec(global, "a1 a2"));
	show("exec global 3", () => exec(global, "a1 a2"));
	const sticky = /b/y;
	sticky.lastIndex = 1;
	show("exec sticky", () => exec(sticky, "ab"));
	show("exec sticky miss", () => exec(sticky, "ab"));
	show("exec coerced input", () => exec(/(\d+)/, { toString: () => "x42" }));
	show("exec null input", () => exec(/nu(ll)/, null));
	const named = /(?<word>\w+)-(?<n>\d+)/;
	show("exec groups", () => exec(named, "abc-12").groups);
	show("exec lookalike", () => exec(lookalike, "x"));
	const own = /x/;
	own.exec = () => "own exec property";
	show("exec own property", () => exec(own, "x"));
	show("exec non-regexp", () => exec({ exec: RegExp.prototype.exec }, "x"));

	class Store {
		#values = new Map();
		get(key) {
			return `store get ${key}`;
		}
		set(key, value) {
			this.#values.set(key, value);
			return `store set ${key}`;
		}
		has(key) {
			return this.#values.has(key) ? "store has" : "store lacks";
		}
	}
	const store = new Store();
	const channel = {
		get: (key) => `channel get ${key}`,
		set: (key) => `channel set ${key}`,
		has: (key) => `channel has ${key}`,
	};
	const map = new Map();
	for (const target of [store, channel, map, new WeakMap(), new Set()]) {
		const key = target instanceof WeakMap ? store : "k";
		show(`set ${target.constructor.name}`, () =>
			target instanceof Set ? target.add(key).size : write(target, key, 1) === target,
		);
		show(`get ${target.constructor.name}`, () =>
			target instanceof Set ? "no get" : read(target, key),
		);
		show(`has ${target.constructor.name}`, () => holds(target, key));
	}
	if (round === 1 && process.env.GUARDED_STRING_PATCH === "1") {
		const original = String.prototype.toLowerCase;
		String.prototype.toLowerCase = function () {
			return `patched ${original.call(this)}`;
		};
		String.prototype.toUpperCase = () => "patched toUpperCase";
		String.prototype.indexOf = () => "patched indexOf";
		String.prototype.lastIndexOf = () => "patched lastIndexOf";
		String.prototype.includes = () => "patched includes";
		String.prototype.startsWith = () => "patched startsWith";
		String.prototype.endsWith = () => "patched endsWith";
		String.prototype.slice = () => "patched slice";
		String.prototype.substring = () => "patched substring";
		String.prototype.substr = () => "patched substr";
		RegExp.prototype.exec = () => null;
	}
}
lines.push(log.join(","));
console.log(lines.join("\n"));
