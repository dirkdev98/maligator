"use strict";

function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

globalThis.run = function run(seed) {
	let calls = 0;
	const failure = { message: "graph failure " + seed };
	const leaf = function leaf(x, bias) {
		calls++;
		if (bias === -99) throw failure;
		return (
			x +
			bias +
			0 +
			(x + bias + 1) +
			(x + bias + 2) +
			(x + bias + 3) +
			(x + bias + 4) +
			(x + bias + 5) +
			(x + bias + 6) +
			(x + bias + 7) +
			(x + bias + 8) +
			(x + bias + 9) +
			(x + bias + 10) +
			(x + bias + 11) +
			(x + bias + 12) +
			(x + bias + 13) +
			(x + bias + 14) +
			(x + bias + 15) +
			(x + bias + 16) +
			(x + bias + 17) +
			(x + bias + 18) +
			(x + bias + 19) +
			(x + bias + 20) +
			(x + bias + 21) +
			(x + bias + 22) +
			(x + bias + 23)
		);
	};
	const helper = function helper(x, bias) {
		if (x < 0) return leaf(-x, bias) - bias;
		return leaf(x, bias) + bias;
	};
	const visitor = function visitor(x, bias) {
		let sum = 0;
		for (let j = 0; j < 3; j++) sum += helper(x + j, bias);
		return sum;
	};
	const recurse = function recurse(depth, bias) {
		if (depth === 0) return visitor(0, bias);
		return recurse(depth - 1, bias) + 1;
	};
	// Preserve observable generic entries as well as the connected numeric entries.
	globalThis.visitor = visitor;
	globalThis.helper = helper;
	globalThis.leaf = leaf;
	let bias = seed | 0;
	let total = 0;
	for (let i = 0; i < 100; i++) {
		bias = (bias + 1) | 0;
		total += visitor(i, bias);
	}
	return {
		total,
		visitor,
		helper,
		leaf,
		recurse,
		failure,
		read: () => calls,
		reset: (value) => {
			calls = value;
		},
	};
};

const first = globalThis.run(2);
const second = globalThis.run(9);
check("first numeric graph", first.total, 840150);
check("second numeric graph", second.total, 892650);
check("first activation counter", first.read(), 300);
check("second activation counter", second.read(), 300);
first.reset(10);
check("escaped visitor numeric bridge", first.visitor(2, 4), 1344);
check("escaped helper negative branch", first.helper(-2, 4), 416);
check("shared mutable state after reset", first.read(), 14);
check("activation counters stay independent", second.read(), 300);

let stringLeaf = "";
for (let i = 0; i < 24; i++) stringLeaf += "23" + i;
check("escaped leaf preserves string addition", first.leaf("2", 3), stringLeaf);
check("escaped helper preserves string result", first.helper("2", 3), stringLeaf + 3);
let stringVisitor = "0";
for (let j = 0; j < 3; j++) {
	let part = "";
	for (let i = 0; i < 24; i++) part += "2" + j + "3" + i;
	stringVisitor += part + 3;
}
check("escaped visitor preserves string arguments", first.visitor("2", 3), stringVisitor);

const events = [];
function argument(label, value) {
	events.push(label);
	return value;
}
const left = {
	valueOf() {
		events.push("left");
		return 2;
	},
};
const right = {
	valueOf() {
		events.push("right");
		return 3;
	},
};
check(
	"generic object arguments reach the same leaf",
	first.leaf(argument("arg-left", left), argument("arg-right", right)),
	396,
);
let expectedEvents = "arg-left,arg-right";
for (let i = 0; i < 24; i++) expectedEvents += ",left,right";
check(
	"argument evaluation and repeated coercion order",
	events.join(","),
	expectedEvents,
);

events.length = 0;
const coercionFailure = { message: "coercion failure" };
let caught;
try {
	first.leaf(
		argument("arg-left", {
			valueOf() {
				events.push("throw");
				throw coercionFailure;
			},
		}),
		argument("arg-right", right),
	);
} catch (error) {
	caught = error;
}
check("generic bridge preserves thrown identity", caught, coercionFailure);
check(
	"coercion exception stops later coercions",
	events.join(","),
	"arg-left,arg-right,throw",
);

check("recursive calls reach the numeric graph", first.recurse(5, 4), 1205);
caught = undefined;
const beforeThrow = first.read();
try {
	first.recurse(5, -99);
} catch (error) {
	caught = error;
}
check("throw crosses leaf helper visitor and recursion", caught, first.failure);
check("throw stops the visitor after one leaf", first.read(), beforeThrow + 1);
check("other activation survives graph exception", second.visitor(1, 2), 1122);
check("graph remains callable after exception", first.visitor(0, 1), 975);

console.log("connected-native-calls PASS");
