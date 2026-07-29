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

function stackObjectProbe(value, escape) {
	const object = { value };
	if (escape) return object;
	return typeof object === "object" ? object.value : 0;
}

function runStackObjectProbe(count) {
	let result = 0;
	for (let i = 0; i < count; i++) {
		const value = stackObjectProbe(i, i === count - 1);
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
	total += loadStringLength(i % 2 === 0 ? "s" : "stats");
	total += loadArrayLength(lengthArray);
	total += readPair(polymorphicObjects[i % polymorphicObjects.length]);
}

if (total <= 0) throw new Error("expected work");
let binaryProbe = total;
binaryProbe = (binaryProbe << 3) ^ (binaryProbe >>> 2);
if (typeof binaryProbe !== "number") throw new Error("expected numeric binary probe");
console.log("perf-stats PASS 1/1");
