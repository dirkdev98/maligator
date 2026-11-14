// Warm loops over compiled builtin identities after a polyfill installed unrelated
// methods on watched built-ins. Locked primordials reject the installs, which
// change no result here.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function polyfill(target, name, value) {
	if (Object.isFrozen(target)) return;
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
}
polyfill(String.prototype, "capitalize", function () {
	return this.charAt(0).toUpperCase() + this.slice(1);
});
polyfill(Array.prototype, "lastItem", function () {
	return this[this.length - 1];
});
polyfill(Map.prototype, "getOr", function (key, fallback) {
	return this.has(key) ? this.get(key) : fallback;
});
polyfill(Set.prototype, "addAll", function (values) {
	for (const value of values) this.add(value);
	return this;
});
polyfill(RegExp.prototype, "matchesAll", function (text) {
	return this.test(text);
});
polyfill(Object.prototype, "__polyfilled", true);
polyfill(Object, "fromPairs", (pairs) => Object.fromEntries(pairs));
polyfill(Math, "clamp", (value, low, high) => Math.min(Math.max(value, low), high));
polyfill(Promise, "delay", (value) => Promise.resolve(value));
if (
	!Object.isFrozen(String.prototype) &&
	[
		"abc".capitalize(),
		[1, 2].lastItem(),
		new Map().getOr(1, 2),
		Math.clamp(9, 0, 4),
	].join() !== "Abc,2,2,4"
) {
	throw new Error("polyfills were not installed");
}

function charCodes(text) {
	let total = 0;
	for (let index = 0; index < text.length; index++)
		total = (total + text.charCodeAt(index)) | 0;
	return total;
}

function splitFields(line) {
	let total = 0;
	for (const field of line.split(",")) total += field.trim().length;
	return total;
}

function execCaptures(lines, pattern) {
	let total = 0;
	for (const line of lines) {
		const match = pattern.exec(line);
		if (match !== null) total += match[1].length + match[2].length;
	}
	return total;
}

function matchAllCaptures(text) {
	let total = 0;
	for (const match of text.matchAll(/(\d+)-(\w+)/g))
		total += match[1].length + match[2].length;
	return total;
}

function mapEntries(map) {
	let total = 0;
	for (const [key, value] of map) total += key.length + value;
	return total;
}

function setEntries(set) {
	let total = 0;
	for (const [first, second] of set.entries()) total += first + second;
	return total;
}

function lookups(map, set, keys) {
	let total = 0;
	for (const key of keys) {
		if (set.has(key)) total += map.get(key);
	}
	return total;
}

function assignRow(index) {
	const row = Object.assign({}, { id: index, revision: index & 31, label: "row" });
	return row.revision + row.label.length;
}

async function settleAll(rounds) {
	let total = 0;
	for (let round = 0; round < rounds; round++) {
		const [first, second] = await Promise.all([
			Promise.resolve(round),
			Promise.resolve(1),
		]);
		total += first + second;
	}
	return total;
}

const text = "polyfilled scanner input with ASCII text, ".repeat(4);
const line = " alpha, beta ,gamma,  delta,epsilon ,zeta";
const lines = ["a1=bb", "c22=d", "no match", "eee333=ffff"];
const pattern = /([a-z]+)\d*=(\w+)/;
const pairs = "1-a 22-bb 333-ccc 4444-dddd";
const map = new Map(
	["one", "two", "three", "four", "five"].map((key, index) => [key, index + 1]),
);
const set = new Set([1, 2, 3, 4, 5]);
const keys = ["one", "two", "three", "four", "five"];
const keySet = new Set(["one", "three", "five"]);
const loops = 200;
let codes = 0;
let fields = 0;
let captures = 0;
let iterated = 0;
let mapped = 0;
let setted = 0;
let found = 0;
let assigned = 0;
for (let round = 0; round < loops; round++) {
	codes += charCodes(text);
	fields += splitFields(line);
	captures += execCaptures(lines, pattern);
	iterated += matchAllCaptures(pairs);
	mapped += mapEntries(map);
	setted += setEntries(set);
	found += lookups(map, keySet, keys);
	assigned += assignRow(round);
}
record("codes", codes);
record("fields", fields);
record("captures", captures);
record("iterated", iterated);
record("mapped", mapped);
record("setted", setted);
record("found", found);
record("assigned", assigned);
record("settled", await settleAll(loops));
record("concat", [1, 2].concat([3, 4], 5).join());
record("species", [1, 2, 3].map((value) => value * 2).constructor === Array);
record("error", String(new TypeError("message")));
record("loops", loops);

console.log(results.join("\n"));
