// Numeric loops calling Math builtins through mutable globals, which a program may
// replace before, between or during the loops, and restore again.
const results = [];
function record(label, value) {
	results.push(`${label}=${Object.is(value, -0) ? "-0" : String(value)}`);
}

const originalMath = Math;
const originalTrunc = Math.trunc;
const originalMax = Math.max;
let replacementCalls = 0;

const floats = new Float64Array(64);
for (let index = 0; index < floats.length; index++) floats[index] = index * 1.75 - 20.5;
const numbers = Array.from(floats);
const records = Array.from({ length: 48 }, (_, id) => ({
	id,
	position: { x: id * 0.75 - 9.5, y: id & 7 },
}));

function typedTrunc(values) {
	let sum = 0;
	for (let index = 0; index < values.length; index++) sum += Math.trunc(values[index]);
	return sum;
}
function typedMax(values) {
	let sum = 0;
	for (let index = 0; index < values.length; index++)
		sum += Math.max(values[index], -3.5);
	return sum;
}
function arrayTrunc(values) {
	let sum = 0;
	for (const value of values) sum += Math.trunc(value) * 2;
	return sum;
}
function recordTrunc(list) {
	let sum = 0;
	for (const entry of list) {
		const { position } = entry;
		position.y = (position.y + 1) & 15;
		sum += Math.trunc(position.x) + position.y;
	}
	return sum;
}
function observedTrunc(values, observe) {
	let sum = 0;
	for (let index = 0; index < values.length; index++) {
		observe(index);
		sum += Math.trunc(values[index]);
	}
	return sum;
}
function all(label) {
	record(`${label}.typed`, typedTrunc(floats));
	record(`${label}.max`, typedMax(floats));
	record(`${label}.array`, arrayTrunc(numbers));
	record(`${label}.records`, recordTrunc(records));
}

const loops = 40;
let warm = 0;
for (let round = 0; round < loops; round++)
	warm +=
		typedTrunc(floats) + typedMax(floats) + arrayTrunc(numbers) + recordTrunc(records);
record("warm", warm);
record("loops", loops);

// Replaced before the loops run.
Math.trunc = (value) => {
	replacementCalls++;
	return originalTrunc(value) + 1;
};
Math.max = (left, right) => {
	replacementCalls++;
	return originalMax(left, right) * 2;
};
all("replaced");
record("replaced.calls", replacementCalls);
Math.trunc = originalTrunc;
Math.max = originalMax;
all("restored");

// A getter for the method runs on every load.
let getterLoads = 0;
Object.defineProperty(Math, "trunc", {
	configurable: true,
	get() {
		getterLoads++;
		return originalTrunc;
	},
});
all("getter");
record("getter.loads", getterLoads);
Object.defineProperty(Math, "trunc", {
	configurable: true,
	writable: true,
	value: originalTrunc,
});
all("getter-restored");

// Another global `Math` object, then a global accessor counting its loads.
globalThis.Math = {
	trunc: (value) => -originalTrunc(value),
	max: (left, right) => originalMax(left, right) - 1,
};
all("global-object");
globalThis.Math = originalMath;
let globalLoads = 0;
Object.defineProperty(globalThis, "Math", {
	configurable: true,
	get() {
		globalLoads++;
		return originalMath;
	},
});
all("global-getter");
record("global-getter.loads", globalLoads);
Object.defineProperty(globalThis, "Math", {
	configurable: true,
	writable: true,
	value: originalMath,
});
all("global-restored");

// Replaced from inside a loop by its own callback, then restored by a later one.
replacementCalls = 0;
record(
	"observed",
	observedTrunc(floats, (index) => {
		if (index === 20)
			Math.trunc = (value) => {
				replacementCalls++;
				return originalTrunc(value) * 10;
			};
		if (index === 40) Math.trunc = originalTrunc;
	}),
);
record("observed.calls", replacementCalls);
all("final");

// Deleting the global makes each load throw.
delete globalThis.Math;
try {
	typedTrunc(floats);
	record("deleted", "no error");
} catch (error) {
	record("deleted", error.constructor.name);
}
globalThis.Math = originalMath;
all("recreated");

console.log(results.join("\n"));
