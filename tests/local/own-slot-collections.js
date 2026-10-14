"use strict";
const mode = process.env.OWN_SLOT_MODE ?? "array";
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function references(record) {
	const left = record.left;
	const right = record.right;
	const tail = record.tail;
	return [left, right, tail];
}
function sum(record) {
	return record.a + record.b + record.c + record.d + record.e;
}
function extent(record) {
	const left = record.left;
	const length = record.length;
	const right = record.right;
	const size = record.size;
	return [left, length, right, size];
}
function internals(record) {
	const left = record.left;
	const bytes = record.byteLength;
	const right = record.right;
	const index = record.lastIndex;
	const tail = record.tail;
	return [left, bytes, right, index, tail];
}
globalThis.readCollectionReferences = references;
globalThis.sumCollectionNumbers = sum;
globalThis.readCollectionExtent = extent;
globalThis.readBuiltinInternals = internals;
const kinds = [
	"array",
	"typed",
	"map",
	"set",
	"date",
	"regexp",
	"promise",
	"buffer",
	"view",
];
function make(kind) {
	if (kind === "array") return [11, 22, 33];
	if (kind === "typed") return new Uint16Array([11, 22, 33]);
	if (kind === "map")
		return new Map([
			[1, 11],
			[2, 22],
			[3, 33],
		]);
	if (kind === "set") return new Set([11, 22, 33]);
	if (kind === "date") return new Date(0);
	if (kind === "regexp") return /x/g;
	if (kind === "promise") return Promise.resolve(11);
	if (kind === "buffer") return new ArrayBuffer(8);
	return new DataView(new ArrayBuffer(8));
}
const marker = { marker: "retained" };
function fill(record, reverse) {
	const values = reverse
		? { e: 5, d: 4, c: 3, b: 2, a: 1, tail: "tail", right: marker, left: marker }
		: { left: marker, right: marker, tail: "tail", a: 1, b: 2, c: 3, d: 4, e: 5 };
	return Object.assign(record, values);
}
const rows = [];
if (mode === "fallback") {
	for (const kind of kinds) {
		const record = fill(make(kind), false);
		for (let i = 0; i < 5; i++) globalThis.readCollectionReferences(record);
		let reads = 0;
		Object.defineProperty(record, "right", {
			get() {
				reads++;
				collect();
				record.tail = "changed";
				return marker;
			},
			configurable: true,
		});
		const result = globalThis.readCollectionReferences(record);
		if (
			result[0] !== marker ||
			result[1] !== marker ||
			result[2] !== "changed" ||
			reads !== 1
		)
			throw new Error("stale borrowed reference");
		rows.push(kind, reads, result[2]);
		const events = [];
		const proxy = new Proxy(fill(make(kind), true), {
			get(target, key) {
				events.push(String(key));
				collect();
				return target[key];
			},
		});
		rows.push(globalThis.sumCollectionNumbers(proxy), events);
		const coercing = fill(make(kind), false);
		coercing.a = {
			valueOf() {
				collect();
				coercing.b = 20;
				return 1;
			},
		};
		if (globalThis.sumCollectionNumbers(coercing) !== 15 || coercing.b !== 20)
			throw new Error("coercion reordered");
		rows.push(15, coercing.b);
		const inherited = fill(make(kind), false);
		delete inherited.c;
		Object.setPrototypeOf(inherited, { c: 30 });
		if (globalThis.sumCollectionNumbers(inherited) !== 42)
			throw new Error("inherited own-slot confusion");
		rows.push(42);
	}
	const array = fill([7, 8, 9], false);
	for (let i = 0; i < 6; i++) rows.push(globalThis.readCollectionExtent(array).slice(1));
	array.length = 1;
	if (globalThis.readCollectionExtent(array)[1] !== 1)
		throw new Error("stale array length");
	const typed = fill(new Uint16Array([7, 8, 9]), false);
	for (let i = 0; i < 6; i++) globalThis.readCollectionExtent(typed);
	const buffer = typed.buffer;
	if (typeof buffer.transfer === "function") {
		buffer.transfer();
		if (
			globalThis.readCollectionExtent(typed)[1] !== 0 ||
			globalThis.sumCollectionNumbers(typed) !== 15
		)
			throw new Error("detached own slots");
		rows.push("detached");
	}
	for (const kind of ["map", "set"]) {
		const record = fill(make(kind), false);
		for (let i = 0; i < 6; i++) globalThis.readCollectionExtent(record);
		record.clear();
		if (globalThis.readCollectionExtent(record)[3] !== 0)
			throw new Error("stale collection size");
		rows.push("cleared");
	}
	const regexp = fill(/x/g, false);
	for (let i = 0; i < 6; i++) globalThis.readBuiltinInternals(regexp);
	regexp.exec("x x");
	if (globalThis.readBuiltinInternals(regexp)[3] !== 1)
		throw new Error("stale regexp index");
	regexp.exec("x x");
	if (globalThis.readBuiltinInternals(regexp)[3] !== 3)
		throw new Error("second regexp index lost");
	rows.push("regexp advanced");
	const backing = fill(new ArrayBuffer(8), false);
	const view = fill(new DataView(backing), false);
	for (let i = 0; i < 6; i++) {
		globalThis.readBuiltinInternals(backing);
		globalThis.readBuiltinInternals(view);
	}
	if (typeof backing.transfer === "function") {
		backing.transfer();
		if (globalThis.readBuiltinInternals(backing)[1] !== 0)
			throw new Error("stale buffer length");
		let caught = false;
		try {
			globalThis.readBuiltinInternals(view);
		} catch (error) {
			caught = error instanceof TypeError;
		}
		if (!caught || globalThis.sumCollectionNumbers(view) !== 15)
			throw new Error("detached view fallback lost");
		rows.push("view detached");
	}
	const date = fill(new Date(0), false);
	for (let i = 0; i < 6; i++) globalThis.sumCollectionNumbers(date);
	date.setTime(1234);
	if (date.getTime() !== 1234 || globalThis.sumCollectionNumbers(date) !== 15)
		throw new Error("date state confused with own fields");
	rows.push("date changed");
} else {
	const selected = mode === "mixed" || mode === "dictionary" ? kinds : [mode];
	for (let round = 0; round < 5; round++)
		for (const kind of selected) {
			const record = fill(make(kind), round % 2 !== 0);
			if (mode === "dictionary") for (let i = 0; i < 80; i++) record[`extra${i}`] = i;
			if (round === 4 && kind !== "typed") Object.freeze(record);
			for (let visit = 0; visit < 6; visit++) {
				const values = globalThis.readCollectionReferences(record);
				if (values[0] !== marker || values[1] !== marker || values[2] !== "tail")
					throw new Error("reference lost");
				const number = globalThis.sumCollectionNumbers(record);
				if (number !== 15) throw new Error("numeric field lost");
				const dimensions = globalThis.readCollectionExtent(record);
				if (dimensions[0] !== marker || dimensions[2] !== marker)
					throw new Error("extent root lost");
				const expectedLength = kind === "array" || kind === "typed" ? 3 : undefined;
				const expectedSize = kind === "map" || kind === "set" ? 3 : undefined;
				if (dimensions[1] !== expectedLength || dimensions[3] !== expectedSize)
					throw new Error("internal property lost");
				const state = globalThis.readBuiltinInternals(record);
				if (state[0] !== marker || state[2] !== marker || state[4] !== "tail")
					throw new Error("internal continuation root lost");
				const bytes =
					kind === "typed" ? 6 : kind === "buffer" || kind === "view" ? 8 : undefined;
				if (state[1] !== bytes || state[3] !== (kind === "regexp" ? 0 : undefined))
					throw new Error("internal state lost");
				rows.push([kind, number, dimensions[1], dimensions[3]]);
				collect();
			}
		}
}
console.log(JSON.stringify(rows));
