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
map.set("alpha", 1);
map.set("beta", 2);

const counter = new Counter(3);
let total = 0;
for (let i = 0; i < 2000; i++) {
	const object = objects[i % objects.length];
	total += object.alpha;
	object.alpha = (object.alpha + 1) % 1000;
	const dynamicKey = i % 2 === 0 ? ["be", "ta"].join("") : ["gam", "ma"].join("");
	total += object[dynamicKey];
	total += map.get(i % 2 === 0 ? "alpha" : "beta");
	total += counter.read();
}

if (total <= 0) throw new Error("expected work");
console.log("perf-stats PASS 1/1");
