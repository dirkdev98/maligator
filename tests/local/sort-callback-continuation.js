"use strict";

const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const typed = process.env.SORT_CALLBACK_KIND === "typed";
const mixed = process.env.SORT_CALLBACK_KIND === "mixed";
const rows = [];
let direction = 1;
let calls = 0;
let reenter = false;
let fail = false;
let active;
let mutate;

function values() {
	return typed
		? new BigInt64Array([7n, 2n, 4n, 2n])
		: mixed
			? [7, 2, "4", "2"]
			: ["7", "2", "4", "2"];
}
function orderedFallback(a, b) {
	if (arguments.length !== 2 || this !== undefined) throw new Error("invocation");
	calls++;
	gc?.();
	if (reenter) {
		reenter = false;
		rows.push("nested", values().toSorted(nestedFallback).join(","));
		active[0] = typed ? 99n : "99";
	}
	if (mutate) {
		const effect = mutate;
		mutate = undefined;
		effect();
	}
	if (fail) throw new Error("comparator");
	return (a < b ? -1 : a > b ? 1 : 0) * direction;
}
function nestedFallback(a, b) {
	gc?.();
	return a < b ? 1 : a > b ? -1 : 0;
}
function sortValues(input) {
	return input.sort(orderedFallback);
}
function copyValues(input) {
	return input.toSorted(orderedFallback);
}

active = values();
reenter = true;
rows.push("sort", sortValues(active).join(","), calls > 0);
direction = -1;
active = values();
rows.push("copy", copyValues(active).join(","), active.join(","));
direction = 1;
calls = 0;
fail = true;
active = values();
try {
	sortValues(active);
} catch (error) {
	rows.push("throw", error.message, calls, active.join(","));
}
fail = false;
rows.push("after-throw", sortValues(values()).join(","));

function restFallback(...pair) {
	return pair.length === 2 ? (pair[0] < pair[1] ? -1 : pair[0] > pair[1] ? 1 : 0) : 1;
}
rows.push("rest", values().toSorted(restFallback).join(","));
rows.push("call", values().sort.call(values(), orderedFallback).join(","));

function operandResult(a) {
	calls++;
	gc?.();
	return a;
}
function sortResult(input) {
	return input.sort(operandResult);
}
function copyResult(input) {
	return input.toSorted(operandResult);
}
for (const copy of [false, true]) {
	calls = 0;
	try {
		const input = typed
			? new BigInt64Array([1n, 1n])
			: [Symbol.for("sort"), Symbol.for("sort")];
		if (copy) copyResult(input);
		else sortResult(input);
	} catch (error) {
		rows.push("result-throw", copy, error.name, calls);
	}
}

const replaced = values();
Object.defineProperty(replaced, "sort", {
	value(compare) {
		return compare(typed ? 1n : "1", typed ? 2n : "2") + 10;
	},
});
rows.push("replacement", sortValues(replaced));
const wrongFamily = values();
Object.defineProperty(wrongFamily, "sort", {
	value: typed ? BigInt64Array.prototype.toSorted : Array.prototype.toSorted,
});
rows.push("wrong-family", sortValues(wrongFamily).join(","), wrongFamily.join(","));

if (typed) {
	rows.push(
		"unsigned",
		sortValues(new BigUint64Array([0n, 18446744073709551615n, 2n])).join(","),
	);
	const noSpecies = values();
	Object.defineProperty(noSpecies, "constructor", {
		get() {
			throw new Error("species");
		},
	});
	rows.push("no-species", copyValues(noSpecies).join(","));
	const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
	active = new BigInt64Array(buffer);
	active.set([7n, 2n, 4n, 2n]);
	mutate = () => buffer.resize(16);
	rows.push("resize-copy", copyValues(active).join(","), active.length);
	const shrinking = new ArrayBuffer(32, { maxByteLength: 64 });
	active = new BigInt64Array(shrinking);
	active.set([7n, 2n, 4n, 2n]);
	mutate = () => shrinking.resize(16);
	rows.push("resize-sort", sortValues(active).join(","));
	const detached = new ArrayBuffer(32);
	active = new BigInt64Array(detached);
	active.set([7n, 2n, 4n, 2n]);
	mutate = () => detached.transfer();
	rows.push("detach-copy", copyValues(active).join(","), active.length);
	const detaching = new ArrayBuffer(32);
	active = new BigInt64Array(detaching);
	active.set([7n, 2n, 4n, 2n]);
	mutate = () => detaching.transfer();
	rows.push("detach-sort", sortValues(active) === active, active.length);
	const shared = new BigInt64Array(new SharedArrayBuffer(32));
	shared.set([7n, 2n, 4n, 2n]);
	mutate = () => {
		shared[0] = 88n;
	};
	rows.push("shared", sortValues(shared).join(","));
} else {
	let coercions = 0;
	const result = {
		valueOf() {
			coercions++;
			gc?.();
			return 0;
		},
	};
	calls = 0;
	rows.push(
		"object-result",
		sortResult([result, result])[0] === result,
		calls,
		coercions,
	);
	calls = 0;
	rows.push(
		"object-copy-result",
		copyResult([result, result])[0] === result,
		calls,
		coercions,
	);
	const a = {
		valueOf() {
			gc?.();
			return 3;
		},
		toString() {
			return "3";
		},
	};
	rows.push("object-pair", sortValues(["2", a, "1"]).join(","));
	const sparse = ["7", , undefined, "2"];
	const sorted = sortValues(sparse);
	rows.push("holes", sorted.join(","), Object.keys(sorted).join(","));
	rows.push("holes-copy", copyValues(["7", , undefined, "2"]).join(","));
}
console.log(JSON.stringify(rows));
