function imul(x, y) {
	return Math.imul(x, y);
}
function clz32(x) {
	return Math.clz32(x);
}
function f16round(x) {
	return Math.f16round(x);
}
function pow(x, y) {
	return Math.pow(x, y);
}
function atan2(x, y) {
	return Math.atan2(x, y);
}
function missingImul(x) {
	return Math.imul(x);
}
function extraImul(x, y) {
	return Math.imul(x, y, ++effects);
}
Object.assign(globalThis, { imul, clz32, f16round, pow, atan2, missingImul, extraImul });
const results = [];
function record(value) {
	results.push(Object.is(value, -0) ? "-0" : String(value));
}
for (const value of [NaN, Infinity, -Infinity, -0, 0, 1, -1, 1.5, -1.5, 4294967297]) {
	record(globalThis.imul(value, 5));
	record(globalThis.clz32(value));
	record(globalThis.f16round(value));
	record(globalThis.pow(value, 2));
	record(globalThis.atan2(value, Infinity));
}
record(globalThis.missingImul(7));
for (const value of [undefined, null, true, false, "3.5", "invalid"]) {
	record(globalThis.imul(value, "2"));
	record(globalThis.clz32(value));
	record(globalThis.f16round(value));
	record(globalThis.pow(value, "2"));
	record(globalThis.atan2(value, Infinity));
}
const order = [];
const left = {
	valueOf() {
		order.push("left");
		return 4294967297;
	},
};
const right = {
	valueOf() {
		order.push("right");
		return -3;
	},
};
record(globalThis.imul(left, right));
record(order.join(","));
order.length = 0;
const marker = {};
const throwing = {
	valueOf() {
		order.push("throw");
		throw marker;
	},
};
try {
	globalThis.imul(throwing, right);
} catch (error) {
	record(error === marker);
}
record(order.join(","));
for (const operation of [
	globalThis.imul,
	globalThis.clz32,
	globalThis.f16round,
	globalThis.pow,
	globalThis.atan2,
]) {
	for (const value of [1n, Symbol()]) {
		try {
			operation(value, 2);
			record("missing error");
		} catch (error) {
			record(error instanceof TypeError);
		}
	}
}
let effects = 0;
record(globalThis.extraImul(3, 7));
record(effects);
record(globalThis.pow(-0, 3));
record(globalThis.pow(1, Infinity));
record(globalThis.atan2(-0, 0));
console.log(JSON.stringify(results));
