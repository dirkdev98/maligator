"use strict";

function pick(key) {
	return arguments[key];
}

function nested(key) {
	return `${pick(key, "inner")} ${arguments[1]}`;
}
console.log("frame", nested(1, "outer"));

function create() {
	const original = { value: 7 };
	const returned = pick(2, "unused", original);
	return { original, returned };
}
const retained = create();
for (let round = 0; round < 500; round++) {
	const padding = Array.from({ length: 4 }, (_, value) => ({ value }));
	if (padding.length !== 4) throw new Error("Missing allocation pressure");
}
retained.returned.value++;
console.log("retained", retained.returned === retained.original, retained.original.value);

function collect() {
	const args = arguments;
	let value = "";
	for (let index = args.length - 1; index >= 0; index--) {
		const padding = [index, index + 1].map((value) => ({ value }));
		value += args[index].name + padding.length;
	}
	return value;
}
console.log("alias", collect({ name: "a" }, { name: "b" }, { name: "c" }));

let conversions = 0;
const key = {
	toString() {
		conversions++;
		return "1";
	},
};
console.log("keys", Object.is(pick(-0, "own"), -0), pick(key, "own"), conversions);
console.log("invalid", pick(-1), pick(0.5), pick(NaN), pick(Infinity));

function materialized(key) {
	arguments[1] = "replaced";
	return arguments[key];
}
console.log("materialized", materialized(1, "own"));
