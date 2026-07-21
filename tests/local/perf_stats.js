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

const counter = new Counter(3);
let total = 0;
for (let i = 0; i < 2000; i++) {
	const object = objects[i % objects.length];
	total += object.alpha;
	object.alpha = (object.alpha + 1) % 1000;
	const dynamicKey = i % 2 === 0 ? ["be", "ta"].join("") : ["gam", "ma"].join("");
	total += object[dynamicKey];
	total += map.get(mapKeys[i % mapKeys.length]);
	total += counter.read();
}

if (total <= 0) throw new Error("expected work");
console.log("perf-stats PASS 1/1");
