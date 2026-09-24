"use strict";

class Counter {
	constructor(value) {
		this.value = value;
	}

	read() {
		return this.value;
	}
}

const objects = [];
for (let i = 0; i < 64; i++) {
	objects.push({ alpha: i, beta: i + 1, gamma: i + 2 });
}

const map = new Map();
const mapKeys = [];
for (let i = 0; i < 40; i++) {
	const key = "map-" + i;
	mapKeys.push(key);
	map.set(key, i + 1);
}

const collisionKeys = [
	"collision-11",
	"collision-23",
	"collision-24",
	"collision-32",
	"collision-36",
	"collision-53",
];
const collisionMap = new Map(collisionKeys.map((key, index) => [key, index + 1]));
collisionMap.delete(collisionKeys[0]);
for (let i = 1; i < collisionKeys.length; i++) {
	if (collisionMap.get(collisionKeys[i]) !== i + 1)
		throw new Error("broken collision chain");
}

const dictionary = {};
Object.defineProperty(dictionary, "anchor", { value: 1, configurable: true });
for (let i = 0; i < 40; i++) {
	Object.defineProperty(dictionary, "dict-" + i, {
		value: i,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
if (dictionary["dict-39"] !== 39) throw new Error("broken dictionary insertion");

const accessorProbe = {};
Object.defineProperty(accessorProbe, "value", {
	configurable: true,
	get() {
		return 7;
	},
});
if (accessorProbe.value !== 7) throw new Error("broken accessor sidecar");
Object.defineProperty(accessorProbe, "value", {
	configurable: true,
	writable: true,
	value: 8,
});
if (accessorProbe.value !== 8) throw new Error("broken accessor-to-data transition");

const compactedMap = new Map();
for (let i = 0; i < 40; i++) compactedMap.set("compact-" + i, i);
for (let i = 0; i < 30; i++) compactedMap.delete("compact-" + i);
compactedMap.set("compact-new", 40);
if (
	compactedMap.size !== 11 ||
	compactedMap.get("compact-39") !== 39 ||
	compactedMap.get("compact-new") !== 40
) {
	throw new Error("broken map compaction");
}
compactedMap.clear();

const fanoutKeys = [];
for (let i = 0; i < 160; i++) {
	const key = ["fanout", i].join("-");
	fanoutKeys.push(key);
	const object = {};
	object[key] = i;
}
for (let i = 0; i < fanoutKeys.length; i++) {
	const equalKey = ["fanout", i].join("-");
	const object = {};
	object[equalKey] = i;
	if (object[fanoutKeys[i]] !== i) throw new Error("broken indexed shape transition");
}

const counter = new Counter(3);
const stringMethod = String.prototype.charCodeAt;
const numberMethod = Number.prototype.toFixed;
function concatenate(left, right) {
	return left + right;
}
const inlineConsProbe = concatenate("a", "b");
if (inlineConsProbe !== "ab") throw new Error("broken inline concat");
const consProbe = concatenate("perf-", "stats");
if (consProbe.charCodeAt(5) !== 115) throw new Error("broken cons flatten");
if (consProbe.slice(1, 5) !== "erf-") throw new Error("broken inline slice");
if (consProbe.slice(1, 8) !== "erf-sta") throw new Error("broken dependent slice");
if (
	consProbe.lastIndexOf("stats") !== 5 ||
	consProbe.lastIndexOf("s", 8) !== 5 ||
	consProbe.lastIndexOf("missing") !== -1 ||
	"abcdef".indexOf("z") !== -1
) {
	throw new Error("broken reverse string search");
}
if (
	"already-lower".toLowerCase() !== "already-lower" ||
	"mixed-Case".toLowerCase() !== "mixed-case" ||
	"ALREADY-UPPER".toUpperCase() !== "ALREADY-UPPER" ||
	"mixed-Case".toUpperCase() !== "MIXED-CASE"
) {
	throw new Error("broken string case conversion");
}
const regexpProbe = /(?:stats)/;
if (!regexpProbe.test("perf-stats") || !regexpProbe.test("perf-stats")) {
	throw new Error("broken regexp ASCII execution cache");
}
const fastRegexpMatch = /value=([0-9]+)/.exec("prefix value=42 suffix");
if (fastRegexpMatch[0] !== "value=42" || fastRegexpMatch[1] !== "42") {
	throw new Error("broken regexp fast execution plan");
}

function loadStringMethod(value) {
	return value.charCodeAt;
}

function loadNumberMethod(value) {
	return value.toFixed;
}

function loadStringLength(value) {
	return value.length;
}

function loadArrayLength(value) {
	return value.length;
}

globalThis.loadStringLength = loadStringLength;
globalThis.loadArrayLength = loadArrayLength;

const lengthArray = [1, 2, 3];

function readAfterCoercion(target, coercer) {
	const first = target.alpha + coercer;
	return [first, target.beta];
}

const reshapeTarget = { alpha: 1, beta: 2 };
const reshapeResult = readAfterCoercion(reshapeTarget, {
	valueOf() {
		delete reshapeTarget.beta;
		return 3;
	},
});
if (reshapeResult[0] !== 4 || reshapeResult[1] !== undefined)
	throw new Error("stale consolidated region shape");

function readPair(object) {
	return object.alpha + object.beta;
}

function readFreshEquivalentKey(object) {
	return object[["be", "ta"].join("")];
}

// Keep these recursive edges unreachable so both compiled and interpreted
// attribution exercise one real site whose cache mode alternates.
function loadModeChurn(object, recurse) {
	const value = object.churn;
	return recurse ? loadModeChurn(object, false) : value;
}

function storeModeChurn(object, value) {
	object.churnStore = value;
	if (value === -1) return storeModeChurn(object, 0);
	return value;
}

function stackObjectProbe(value, escape) {
	const object = { value };
	if (escape) return object;
	return typeof object === "object" ? object.value : 0;
}

globalThis.stackObjectProbe = stackObjectProbe;

function runStackObjectProbe(count) {
	let result = 0;
	for (let i = 0; i < count; i++) {
		const value = globalThis.stackObjectProbe(i, i === count - 1);
		result += typeof value === "object" ? value.value : value;
	}
	return result;
}

const polymorphicObjects = [
	{ alpha: 1, beta: 2 },
	{ extra0: 0, alpha: 2, beta: 3 },
	{ extra0: 0, extra1: 1, alpha: 3, beta: 4 },
	{ extra0: 0, extra1: 1, extra2: 2, alpha: 4, beta: 5 },
];
const churnPrototype = { churn: 2 };
const churnOwn = { churn: 1 };
const churnInherited = Object.create(churnPrototype);
let total = 0;
total += runStackObjectProbe(8);
for (let i = 0; i < 2000; i++) {
	const object = objects[i % objects.length];
	total += object.alpha;
	object.alpha = (object.alpha + 1) % 1000;
	const dynamicKey = i % 2 === 0 ? ["be", "ta"].join("") : ["gam", "ma"].join("");
	total += object[dynamicKey];
	total += map.get(mapKeys[i % mapKeys.length]);
	total += counter.read();
	if (loadStringMethod("stats") !== stringMethod) throw new Error("string method cache");
	if (loadNumberMethod(i) !== numberMethod) throw new Error("number method cache");
	total += globalThis.loadStringLength(i % 2 === 0 ? "s" : "stats");
	total += globalThis.loadArrayLength(lengthArray);
	total += loadModeChurn(i % 2 === 0 ? churnOwn : churnInherited, false);
	const churnStore = {};
	storeModeChurn(churnStore, i);
	storeModeChurn(churnStore, i + 1);
	total += readPair(polymorphicObjects[i % polymorphicObjects.length]);
	total += readFreshEquivalentKey(object);
}

if (total <= 0) throw new Error("expected work");
let binaryProbe = total;
binaryProbe = (binaryProbe << 3) ^ (binaryProbe >>> 2);
if (typeof binaryProbe !== "number") throw new Error("expected numeric binary probe");

// Instrumented benchmark-control builds can discard everything above. Leave one
// small operation after the reset so the exit report proves that counting resumed.
if (typeof globalThis.__mal_reset_perf_stats === "function") {
	globalThis.__mal_reset_perf_stats();
	const afterResetKey = ["val", "ue"].join("");
	const afterReset = {};
	afterReset[afterResetKey] = 41;
	afterReset[afterResetKey]++;
	if (afterReset[afterResetKey] !== 42) throw new Error("broken perf reset continuation");
}

console.log("perf-stats PASS 1/1");
