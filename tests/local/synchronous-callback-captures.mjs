import { forEachEstreeChild } from "../../src/compiler/frontend/estree-traversal.ts";

let passed = 0;
function check(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
	passed++;
}
const tree = {
	type: "Program",
	body: [
		{ type: "Identifier", name: "a" },
		{ type: "Identifier", name: "b" },
	],
};
function walk(node, callback, ...args) {
	forEachEstreeChild(node, (child) => callback(child, ...args));
}
function names(node, prefix, output) {
	output.push(prefix + node.name);
}
const output = [];
walk(tree, names, "first:", output);
walk(tree, names, "second:", output);
check(
	output,
	["first:a", "first:b", "second:a", "second:b"],
	"captured rest and callback reuse",
);
const nested = [];
walk(
	tree,
	(node, values) => {
		values.push(node.name);
		if (node.name === "a") walk(tree, names, "nested:", values);
	},
	nested,
);
check(nested, ["a", "nested:a", "nested:b", "b"], "reentrant capture isolation");
const changes = [];
function mutableCapture(node) {
	let prefix = "before:";
	forEachEstreeChild(node, (child) => {
		changes.push(prefix + child.name);
		prefix = "after:";
	});
}
mutableCapture(tree);
check(changes, ["before:a", "after:b"], "captured writes remain live");
const failure = { message: "callback failed" };
try {
	walk(tree, () => {
		throw failure;
	});
} catch (error) {
	check(error === failure, true, "callback exception identity");
}
walk(tree, names, "after-throw:", output);
check(
	output.slice(-2),
	["after-throw:a", "after-throw:b"],
	"recovery after callback exception",
);
const getterOrder = [];
function each(values, callback) {
	for (const value of values) callback(value);
}
function eachOwner(values, callback, seed) {
	each(values, (value) => callback(value, seed));
}
const cleanup = [];
const custom = {
	[Symbol.iterator]() {
		cleanup.push("iterator");
		return {
			next() {
				cleanup.push("next");
				return { value: 1, done: false };
			},
			return() {
				cleanup.push("close");
				throw new Error("close failed");
			},
		};
	},
};
try {
	eachOwner(
		custom,
		() => {
			throw failure;
		},
		7,
	);
} catch (error) {
	check(error === failure, true, "iterator close preserves original throw");
}
check(cleanup, ["iterator", "next", "close"], "custom iterator cleanup");
const withGetter = {
	type: "Program",
	get body() {
		getterOrder.push("get body");
		return tree.body;
	},
};
walk(withGetter, (node) => getterOrder.push(node.name));
check(getterOrder, ["get body", "a", "b"], "getter and callback order");

function repeated(callback) {
	for (let i = 0; i < 3; i++) callback(i);
}
function repeatedOwner(seed) {
	const values = [];
	repeated((value) => values.push(seed + value));
	return values;
}
check(repeatedOwner(7), [7, 8, 9], "general synchronous consumer");
let saved;
function retain(callback) {
	saved = callback;
	for (let i = 0; i < 2; i++) callback(i);
}
function retainingOwner(seed) {
	const values = [];
	retain((value) => {
		values.push(seed + value);
		return values;
	});
}
retainingOwner(10);
check(saved(3), [10, 11, 13], "retained closure outlives owner");
function reflect(callback) {
	for (let i = 0; i < 2; i++) callback(i);
	return [callback.name, callback.length];
}
check(
	reflect(function named(value) {
		return value;
	}),
	["named", 1],
	"callback reflection",
);
let consumer = repeated;
function changingOwner(seed) {
	const values = [];
	consumer((value) => {
		values.push(seed + value);
		return values;
	});
	return values;
}
check(changingOwner(20), [20, 21, 22], "original module binding");
consumer = retain;
check(changingOwner(30), [30, 31], "module binding reassignment");
check(saved(4), [30, 31, 34], "reassigned consumer retains capture");
async function defer(callback) {
	await 0;
	for (let i = 0; i < 2; i++) callback(i);
}
function deferredOwner(seed) {
	const values = [];
	return { values, done: defer((value) => values.push(seed + value)) };
}
const delayed = deferredOwner(40);
await delayed.done;
check(delayed.values, [40, 41], "deferred capture outlives owner");
function* suspend(callback) {
	yield 0;
	for (let i = 0; i < 2; i++) callback(i);
}
function suspendedOwner(seed) {
	const values = [];
	return { values, iterator: suspend((value) => values.push(seed + value)) };
}
const suspended = suspendedOwner(50);
suspended.iterator.next();
suspended.iterator.next();
check(suspended.values, [50, 51], "suspended capture outlives owner");
console.log(`synchronous-callback-captures PASS ${passed}`);
