// Calls whose callee and caller differ in strictness. The callees run user code
// (getters, Proxy traps, valueOf) or read `this`; stores and deletes keep the
// callee's mode.
const log = [];

class Point {
	constructor(x) {
		this.x = x;
	}
	weight() {
		return this.x * 2;
	}
}

function total(points) {
	let sum = 0;
	for (let i = 0; i < points.length; i++) sum += points[i].weight();
	return sum;
}

function frameNames(error) {
	return ["weight", "total"].map((name) =>
		error.stack.split("\n").some((line) => line.includes("at ") && line.includes(name)),
	);
}

const getterPoint = Object.create(Point.prototype, {
	x: {
		get() {
			log.push(`getter ${typeof this}`);
			return 5;
		},
	},
});
const proxied = new Proxy(new Point(3), {
	get(target, key, receiver) {
		log.push(`trap ${String(key)}`);
		return Reflect.get(target, key, receiver);
	},
});
const coercing = new Point({
	valueOf() {
		log.push("valueOf");
		return 7;
	},
});
const throwing = Object.create(Point.prototype, {
	x: {
		get() {
			throw new RangeError("getter failed");
		},
	},
});

console.log("plain", total([new Point(1), new Point(2), new Point(3)]));
console.log("getter", total([new Point(1), getterPoint]));
console.log("proxy", total([proxied, new Point(1)]));
console.log("valueOf", total([coercing]));
try {
	total([new Point(1), throwing]);
} catch (error) {
	console.log("throwing", error.name, error.message, JSON.stringify(frameNames(error)));
}
console.log("primitive receiver", Point.prototype.weight.call(5));

function strictThis() {
	"use strict";
	return this === undefined ? "undefined" : typeof this;
}
function sloppyThisCaller() {
	return [strictThis(), strictThis.call(5), strictThis.call("text")];
}
console.log("strict this", JSON.stringify(sloppyThisCaller()));

const measured = {
	get length() {
		log.push("length getter");
		return 3;
	},
};
function sloppyLength(value) {
	return value.length + 1;
}
function sloppyThis(value) {
	return [typeof this, this === globalThis, value.length];
}
function strictCaller(values) {
	"use strict";
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += sloppyLength(values[i]);
	return [
		sum,
		sloppyThis(measured),
		sloppyThis.call(5, measured),
		sloppyThis.call(undefined, measured),
		sloppyThis.call(null, measured),
	];
}
console.log("sloppy callee", JSON.stringify(strictCaller(["ab", measured, [1]])));

const frozen = Object.freeze({ x: 1 });
function strictStore(object, value) {
	"use strict";
	object.x = value;
}
function sloppyStore(object, value) {
	object.x = value;
}
function strictDelete(object) {
	"use strict";
	return delete object.x;
}
function sloppyDelete(object) {
	return delete object.x;
}
function sloppyStoreCaller() {
	const outcomes = [];
	for (const operation of [() => strictStore(frozen, 2), () => strictDelete(frozen)]) {
		try {
			outcomes.push(operation());
		} catch (error) {
			outcomes.push(error.name);
		}
	}
	return outcomes;
}
function strictStoreCaller() {
	"use strict";
	sloppyStore(frozen, 2);
	return [sloppyDelete(frozen), frozen.x];
}
console.log("stores", JSON.stringify([sloppyStoreCaller(), strictStoreCaller()]));

function consume(values, callback) {
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += callback(values[i]) + values.bias;
	return sum;
}
function strictConsume(values, callback) {
	"use strict";
	return callback(values[0]) + values.bias;
}
const biased = Object.defineProperty([{ amount: 2 }, { amount: 3 }], "bias", {
	get() {
		log.push("bias getter");
		return 10;
	},
});
function consumers(seed) {
	return [
		consume(biased, (value) => value.amount + seed),
		consume(biased, (value) => {
			"use strict";
			return value.amount * seed;
		}),
		strictConsume(biased, (value) => value.amount - seed),
	];
}
console.log("consumers", JSON.stringify(consumers(4)));

function liftedReader(items) {
	let bias = 1;
	const read = (item) =>
		item.value * 1 +
		bias +
		(item.value * 2 + bias) +
		(item.value * 3 + bias) +
		(item.value * 4 + bias) +
		(item.value * 5 + bias) +
		(item.value * 6 + bias) +
		(item.value * 7 + bias) +
		(item.value * 8 + bias);
	let sum = 0;
	for (let i = 0; i < items.length; i++) {
		bias = (bias + 1) | 0;
		sum += read(items[i]);
	}
	return sum;
}
let valueReads = 0;
const counted = {
	get value() {
		valueReads++;
		return 2;
	},
};
console.log("lifted reader", liftedReader([counted, { value: 1 }, counted]), valueReads);

console.log(log.join("\n"));
