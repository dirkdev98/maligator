"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
	}
}

function visit(object, onKey) {
	const keys = [];
	for (const key in object) {
		keys.push(key);
		onKey(key);
	}
	return keys.join(",");
}

const plain = { a: 1, b: 2, c: 3, d: 4 };
expectValue(
	visit(plain, (key) => {
		if (key === "a") delete plain.c;
		if (key === "b") delete plain.a;
	}),
	"a,b,d",
	"an unvisited deleted key is skipped and a visited one stays visited",
);

const bare = Object.create(null);
bare.aa = 1;
bare.ba = 2;
bare.ca = 3;
let accumulated = "";
for (const key in bare) {
	for (const inner in bare) if (inner.startsWith("b")) delete bare[inner];
	accumulated += key + bare[key];
}
expectValue(accumulated, "aa1ca3", "a nested for-in deletes ahead of the outer one");

const wide = {};
for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
let wideTotal = 0;
for (const key in wide) {
	wideTotal += wide[key];
	if (key === "k0") for (let i = 10; i < 20; i++) delete wide[`k${i}`];
}
expectValue(wideTotal, 45, "a wide object skips its deleted half");

const dictionary = {};
for (let i = 0; i < 200; i++) dictionary[`d${i}`] = i;
for (let i = 0; i < 200; i += 2) delete dictionary[`d${i}`];
let dictionaryCount = 0;
for (const key in dictionary) {
	dictionaryCount++;
	if (key === "d1") delete dictionary.d199;
}
expectValue(dictionaryCount, 99, "a dictionary object skips a deleted key");

const parent = { inherited: 1, kept: 2 };
const child = Object.create(parent);
child.own = 0;
expectValue(
	visit(child, (key) => {
		if (key === "own") delete parent.inherited;
	}),
	"own,kept",
	"a key deleted from the prototype is skipped",
);

const shadowed = Object.create({ name: "inherited" });
shadowed.name = "own";
expectValue(
	visit(shadowed, () => {
		delete shadowed.name;
	}),
	"name",
	"a deleted own key is visited only once",
);

const truncated = [0, 1, 2, 3];
let iterations = 0;
for (const key in truncated) {
	iterations++;
	truncated.length = 1;
}
expectValue(iterations, 1, "indices past a shortened length are skipped");

const shifted = ["a", , "b", , "c", "d", "e", "f", "g"];
for (const key in shifted) {
	expectValue(key in shifted, true, `index ${key} is present when visited`);
	shifted.shift();
}

const unshifted = [1, , 3];
let unshiftCalled = false;
expectValue(
	visit(unshifted, () => {
		if (!unshiftCalled) {
			unshiftCalled = true;
			unshifted.unshift(0);
		}
	}),
	"0",
	"an index that became a hole is skipped",
);

String.prototype.extra = 1;
expectValue(
	visit("ab", (key) => {
		if (key === "0") delete String.prototype.extra;
	}),
	"0,1",
	"a string's inherited key deleted mid-enumeration is skipped",
);
expectValue(
	visit("ab", () => {}),
	"0,1",
	"a string's indices",
);

let hasTraps = 0;
const proxy = new Proxy(
	{ x: 1, y: 2 },
	{
		has(target, key) {
			hasTraps++;
			return Reflect.has(target, key);
		},
	},
);
expectValue(
	visit(proxy, () => {}),
	"x,y",
	"a proxy enumerates its keys",
);
expectValue(hasTraps, 0, "the proxy is not asked again per key");

const closures = [];
for (const key in { first: 1, second: 2 }) closures.push(() => key);
expectValue(
	closures.map((read) => read()).join(","),
	"first,second",
	"each iteration binds its own key",
);

const labeled = { a: 1, b: 2, c: 3 };
let outerVisits = 0;
outer: for (const key in labeled) {
	outerVisits++;
	for (const inner in labeled) {
		if (inner === "b") {
			delete labeled.c;
			continue outer;
		}
	}
}
expectValue(outerVisits, 2, "continue to an outer for-in skips a deleted key");

let total = 0;
const counted = { alpha: 1, beta: 2, gamma: 3 };
for (let i = 0; i < 1000; i++) for (const key in counted) total += counted[key];
expectValue(total, 6000, "repeated enumeration without deletion");

console.log("native-for-in-deletion PASS");
