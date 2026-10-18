"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
	}
}

function store(object, key, value) {
	object[key] = value;
}

const keys = ["alpha", "beta", "gamma", "delta"];
const record = { alpha: 0, beta: 0, gamma: 0, delta: 0 };
for (let i = 0; i < 400; i++) store(record, keys[i & 3], i);
expectValue(
	record.alpha + record.beta + record.gamma + record.delta,
	396 + 397 + 398 + 399,
	"cycling keys",
);

const frozen = Object.freeze({ alpha: 1, beta: 2, gamma: 3, delta: 4 });
let rejected = 0;
for (let i = 0; i < 8; i++) {
	try {
		store(frozen, keys[i & 3], 0);
	} catch (error) {
		if (error instanceof TypeError) rejected++;
	}
}
expectValue(rejected, 8, "a frozen object rejects every key");
expectValue(frozen.alpha + frozen.delta, 5, "and keeps its values");

const readOnly = { alpha: 1, beta: 2, gamma: 3, delta: 4 };
Object.defineProperty(readOnly, "gamma", { writable: false });
let readOnlyRejected = 0;
for (let i = 0; i < 8; i++) {
	try {
		store(readOnly, keys[i & 3], 10);
	} catch (error) {
		if (error instanceof TypeError) readOnlyRejected++;
	}
}
expectValue(readOnlyRejected, 2, "a non-writable key rejects its stores");
expectValue(readOnly.gamma, 3, "and keeps its value");

let setterCalls = 0;
const withAccessor = {
	alpha: 0,
	beta: 0,
	get gamma() {
		return 0;
	},
	set gamma(value) {
		setterCalls += value;
	},
	delta: 0,
};
for (let i = 0; i < 8; i++) store(withAccessor, keys[i & 3], 1);
expectValue(setterCalls, 2, "an accessor runs its setter");

const sealed = Object.preventExtensions({ alpha: 0, beta: 0, gamma: 0, delta: 0 });
for (let i = 0; i < 8; i++) store(sealed, keys[i & 3], i);
expectValue(sealed.delta, 7, "a non-extensible object still overwrites");

class Base {}
Base.prototype.alpha = 0;
Base.prototype.beta = 0;
const instance = new Base();
function readAlpha(object) {
	return object.alpha;
}
for (let i = 0; i < 8; i++) {
	readAlpha(instance);
	store(Base.prototype, keys[i & 1], i);
	if (i % 2 === 0)
		expectValue(readAlpha(instance), i, "a prototype store reaches inheritors");
}

globalThis.counterA = 0;
globalThis.counterB = 0;
const globalKeys = ["counterA", "counterB"];
for (let i = 0; i < 8; i++) store(globalThis, globalKeys[i & 1], i);
expectValue(globalThis.counterA + globalThis.counterB, 6 + 7, "global properties");

let mathRejected = false;
try {
	store(Math, ["P", "I"].join(""), 3);
} catch (error) {
	mathRejected = error instanceof TypeError;
}
expectValue(mathRejected, true, "Math.PI stays read-only");
expectValue(Math.PI > 3.14, true, "and keeps its value");

console.log("native-computed-stores PASS");
