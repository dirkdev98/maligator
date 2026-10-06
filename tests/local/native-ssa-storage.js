const gc = globalThis.__mal_collect_garbage ?? (() => {});
globalThis.makeStorageValue = (value) => ({ value, padding: new Array(300).fill(value) });

globalThis.rotateStorage = (left, right, count) => {
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
		gc();
	}
	return `${left.value}:${right.value}`;
};
for (const count of [0, 1, 4])
	console.log(
		"rotate",
		count,
		globalThis.rotateStorage(
			globalThis.makeStorageValue(2),
			globalThis.makeStorageValue(9),
			count,
		),
	);

function rotateScalars(left, right, third, fourth, count) {
	for (let index = 0; index < count; index++) {
		const first = left;
		left = right;
		right = first;
		const second = third;
		third = fourth;
		fourth = second;
	}
	for (let index = 0; index < count - 1; index++) {
		const first = left;
		left = right;
		right = first;
		const second = third;
		third = fourth;
		fourth = second;
	}
	return [left, right, third, fourth];
}
globalThis.rotateScalars = rotateScalars;
for (const count of [0, 1, 4]) {
	const values = rotateScalars(-0, 0 / 0, 1 / 0, -1 / 0, count);
	console.log(
		"scalar-rotation",
		count,
		values
			.map((value) =>
				Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value),
			)
			.join(":"),
	);
}

function rotateFlags(left, right, count) {
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
	}
	return left;
}
globalThis.rotateFlags = rotateFlags;
for (const count of [0, 1, 4])
	console.log("boolean-rotation", count, rotateFlags(true, false, count));

function readEarly(early) {
	if (early) return value;
	let value = 17;
	return value;
}

function projectScalarStorage(value, left, right, count) {
	const total = value.left + value.right;
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
	}
	return [total, left, right];
}
globalThis.projectScalarStorage = projectScalarStorage;
for (const count of [0, 1, 4])
	console.log(
		"project-scalars",
		projectScalarStorage({ left: 3, right: 7 }, 2, 9, count).join(":"),
	);
const propertyOrder = [];
const projectionAccessor = {
	get left() {
		propertyOrder.push("left");
		gc();
		return 11;
	},
	get right() {
		propertyOrder.push("right");
		gc();
		return 13;
	},
};
console.log(
	"project-getters",
	projectScalarStorage(projectionAccessor, 2, 9, 1).join(":"),
);
const projectionProxy = new Proxy(
	{ left: 17, right: 19 },
	{
		get(target, key) {
			propertyOrder.push(key);
			gc();
			return target[key];
		},
	},
);
console.log("project-proxy", projectScalarStorage(projectionProxy, 2, 9, 1).join(":"));
try {
	projectScalarStorage(
		{
			get left() {
				propertyOrder.push("throw-left");
				gc();
				throw new Error("projection-throw");
			},
			get right() {
				throw new Error("unexpected second getter");
			},
		},
		2,
		9,
		1,
	);
	throw new Error("projection failed to throw");
} catch (error) {
	console.log("project-error", error.message);
}
console.log("project-order", propertyOrder.join(":"));
globalThis.readEarly = readEarly;
for (const early of [false, true]) {
	try {
		console.log("tdz", early, readEarly(early));
	} catch (error) {
		gc();
		console.log("tdz", early, error instanceof ReferenceError);
	}
}

globalThis.retryStorage = (read, held) => {
	for (;;) {
		try {
			return read(held);
		} catch (error) {
			gc();
			if (error !== held) throw error;
		}
	}
};
let attempts = 0;
const retryValue = globalThis.makeStorageValue(17);
console.log(
	"retry",
	globalThis.retryStorage((value) => {
		if (++attempts < 4) throw value;
		return value.value + value.padding.length;
	}, retryValue),
	attempts,
);

globalThis.scalarStorage = (left, right, one) => {
	const a = +left;
	const b = +right;
	const subtract = +one;
	return a * b - subtract;
};
const rounding = globalThis.scalarStorage(1 + 2 ** -27, 1 - 2 ** -27, 1);
console.log("rounding", Object.is(rounding, 0));
console.log("negative-zero", Object.is(globalThis.scalarStorage(-0, 2, 0), -0));
console.log("nan", Number.isNaN(globalThis.scalarStorage(0, Infinity, 0)));
console.log("infinity", globalThis.scalarStorage(Infinity, 2, 1));
const coercions = [];
const scalarInput = (value, label) => ({
	valueOf() {
		coercions.push(label);
		return value;
	},
});
console.log(
	"coercions",
	globalThis.scalarStorage(scalarInput(3, "a"), scalarInput(4, "b"), scalarInput(1, "c")),
	coercions.join(""),
);

const scalarCallEffects = [];
globalThis.recordScalarCall = (value, index) => {
	gc();
	scalarCallEffects.push(`${value}:${index}`);
};
function observeScalar(value) {
	for (let index = 0; index < 2; index++) globalThis.recordScalarCall(value, index);
}
globalThis.scalarWithCalls = (left, right, one) => {
	const a = +left;
	const b = +right;
	const subtract = +one;
	observeScalar(a);
	const product = a * b;
	const difference = product - subtract;
	observeScalar(difference);
	return difference;
};
console.log(
	"scalar-calls",
	globalThis.scalarWithCalls(3, 4, 1),
	scalarCallEffects.join(","),
);

function scalarLeaf(condition, left, right) {
	if (condition) return left * right - 1;
	return left / right + 1;
}
function scalarSort(left, right) {
	if (left < right) return (left - right) * 0.5;
	return (left - right) * 0.25;
}
function sortScalarInput(values) {
	return values.sort(scalarSort);
}
console.log("scalar-sort", sortScalarInput([12, 3, 8, -5]).join(","));
globalThis.scalarLeaf = scalarLeaf;
const leafResults = [];
for (let index = 0; index < 3; index++) {
	leafResults.push(scalarLeaf(index > 0, index + 3, 4));
	gc();
}
console.log("scalar-leaf", leafResults.join(","));
console.log("leaf-rounding", Object.is(scalarLeaf(true, 1 + 2 ** -27, 1 - 2 ** -27), 0));

const constantEffects = [];
globalThis.observeConstants = (mask, offset) => {
	gc();
	constantEffects.push(`${mask}:${offset}`);
};
globalThis.scalarConstants = (input, condition) => {
	const mask = 17;
	const offset = 1.25;
	globalThis.observeConstants(mask, offset);
	if (condition) return ((+input & mask) + mask) * offset;
	return (+input + mask) / offset;
};
console.log(
	"scalar-constants",
	globalThis.scalarConstants(31, true),
	globalThis.scalarConstants(31, false),
	constantEffects.join(","),
);
function scalarRegionTail(left, right, other) {
	const product = left * right;
	globalThis.observeConstants(product - 1, other);
	return -(other * other);
}
const tailResults = [];
for (let index = 0; index < 3; index++) {
	tailResults.push(scalarRegionTail(index + 1, 4, 5));
}
console.log("region-tail", tailResults.join(","));
globalThis.scalarConstantZero = (condition) => {
	const value = -0;
	gc();
	if (condition) return value * 2;
	return value / 2;
};
console.log(
	"constant-zero",
	Object.is(globalThis.scalarConstantZero(true), -0),
	Object.is(globalThis.scalarConstantZero(false), -0),
);

globalThis.shiftStorage = (values, selected) => {
	values.pop();
	for (let index = values.length; index > selected; index--) {
		values[index] = values[index - 1];
	}
	return values.join(",");
};
console.log("reverse", globalThis.shiftStorage([5, 7, 11, 13], 1));

globalThis.splitStorage = (value, separator) => {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		total += parts[index].trim().length;
	}
	return total;
};
console.log("split", globalThis.splitStorage("a |bc| def ", "|"));

globalThis.sumRegexStorage = (value, regexp) => {
	let sum = 0;
	for (const match of value.matchAll(regexp)) {
		sum += Number(match[1]);
		if (sum > 10) break;
	}
	return sum;
};
console.log("regexp-exit", globalThis.sumRegexStorage("3,4,8,99", /(\d+)/g));
console.log("regexp-exhausted", globalThis.sumRegexStorage("3,4", /(\d+)/g));
console.log("regexp-empty", globalThis.sumRegexStorage("", /(\d+)/g));

function postProperty(value) {
	return value.count++;
}
function preProperty(value) {
	return --value.count;
}
function addProperty(value, delta) {
	return (value.count += delta);
}
function copyProperty(value, delta) {
	return (value.other = delta - value.count);
}
globalThis.postProperty = postProperty;
globalThis.preProperty = preProperty;
globalThis.addProperty = addProperty;
globalThis.copyProperty = copyProperty;
const updateNumber = (value) => (Object.is(value, -0) ? "-0" : String(value));
for (const initial of [2, -0, 2147483647, NaN, Infinity, -Infinity, "4", 7n]) {
	const value = { count: initial, other: 0 };
	for (let i = 0; i < 3; i++) {
		console.log(
			"property-update",
			updateNumber(postProperty(value)),
			updateNumber(preProperty(value)),
			updateNumber(value.count),
		);
		gc();
	}
}
const updateOrder = [];
let updateHeld = 11;
const updateAccessor = {
	get count() {
		updateOrder.push("get");
		gc();
		return updateHeld;
	},
	set count(value) {
		updateOrder.push(`set:${value}`);
		gc();
		updateHeld = value;
	},
};
console.log("update-accessor", postProperty(updateAccessor), preProperty(updateAccessor));
const updateProxy = new Proxy(
	{ count: 17 },
	{
		get(target, key) {
			updateOrder.push(`proxy-get:${key}`);
			gc();
			return target[key];
		},
		set(target, key, value) {
			updateOrder.push(`proxy-set:${key}:${value}`);
			gc();
			target[key] = value;
			return true;
		},
	},
);
console.log("update-proxy", addProperty(updateProxy, 3));
const updateCoercion = {
	count: {
		valueOf() {
			updateOrder.push("coerce");
			gc();
			updateCoercion.count = 100;
			return 5;
		},
	},
};
console.log("update-coercion", postProperty(updateCoercion), updateCoercion.count);
console.log(
	"update-rhs",
	addProperty(
		{ count: 3 },
		{
			valueOf() {
				updateOrder.push("rhs");
				gc();
				return 9;
			},
		},
	),
);
console.log("update-string", addProperty({ count: "3" }, 4));
console.log("update-bigint", String(addProperty({ count: 3n }, 4n)));
const updatePair = { count: 5, other: 1 };
for (let i = 0; i < 3; i++)
	console.log(
		"update-copy",
		copyProperty(updatePair, 20),
		updatePair.count,
		updatePair.other,
	);
function strictProperty(value) {
	"use strict";
	return ++value.count;
}
for (const value of [
	Object.freeze({ count: 9 }),
	{
		get count() {
			updateOrder.push("throw-get");
			gc();
			throw new Error("update-getter");
		},
	},
	{
		get count() {
			return 9;
		},
		set count(value) {
			gc();
			throw new Error(`update-setter:${value}`);
		},
	},
]) {
	try {
		console.log("update-strict", strictProperty(value));
	} catch (error) {
		console.log("update-error", error instanceof TypeError ? "TypeError" : error.message);
	}
}
const warmedUpdate = { count: 10 };
for (let index = 0; index < 5; index++) strictProperty(warmedUpdate);
Object.freeze(warmedUpdate);
try {
	strictProperty(warmedUpdate);
} catch (error) {
	console.log("update-frozen-cache", error instanceof TypeError, warmedUpdate.count);
}
try {
	addProperty({ count: 3n }, 4);
} catch (error) {
	console.log("update-mixed", error instanceof TypeError);
}
try {
	postProperty({
		count: {
			valueOf() {
				gc();
				throw new Error("update-coercion-throw");
			},
		},
	});
} catch (error) {
	console.log("update-coercion-error", error.message);
}
console.log("update-order", updateOrder.join(":"));

function* wideHolder() {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(99);
	try {
		yield "ready";
		yield held.value;
	} finally {
		console.log("finally", held.value, held.padding.length);
	}
}

async function wideAsync(gate) {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(77);
	try {
		await gate;
	} catch (error) {
		console.log("await-constructor", error.kind, held.value, held.padding.length);
		throw error;
	}
	return held.value + held.padding.length;
}

const suspended = wideHolder();
console.log(suspended.next().value);
gc();
console.log(suspended.next().value);
gc();
try {
	suspended.throw(new Error("resume-throw"));
} catch (error) {
	console.log(error.message);
}
gc();
console.log(suspended.next().done);

let openGate;
const gate = new Promise((resolve) => (openGate = resolve));
wideAsync(gate).then((value) => console.log("async", value));
const invalidAwait = Promise.resolve(1);
Object.defineProperty(invalidAwait, "constructor", {
	get() {
		gc();
		throw { kind: "throwing-getter" };
	},
});
wideAsync(invalidAwait).then(
	() => console.log("unexpected-await-success"),
	(error) => console.log("await-rejected", error.kind),
);
setTimeout(() => {
	gc();
	openGate();
}, 0);

function* consumedResumes() {
	for (let index = 0; index < 2; index++) {
		const value = yield index;
		globalThis.consumeResumeValue(value);
	}
	return "released";
}
globalThis.consumeResumeValue = (value) => {
	globalThis.resumeReference = new WeakRef(value);
};
globalThis.suspendedResumeIterator = consumedResumes();
globalThis.suspendedResumeIterator.next();
function sendResumeValue() {
	globalThis.suspendedResumeIterator.next({ value: 123 });
}
sendResumeValue();
setTimeout(() => {
	gc();
	if (
		typeof globalThis.__mal_collect_garbage === "function" &&
		globalThis.resumeReference.deref() !== undefined
	)
		throw new Error("Suspended resume output retained its previous input");
	globalThis.consumeResumeValue = () => {};
	console.log("resume-output", globalThis.suspendedResumeIterator.next().value);
}, 0);

async function consumedAwaits() {
	for (let index = 0; index < 2; index++) {
		const value = await globalThis.awaitGates[index];
		globalThis.consumeAwaitValue(value);
	}
	return "released";
}
globalThis.consumeAwaitValue = (value) => {
	globalThis.awaitReference = new WeakRef(value);
};
globalThis.awaitGates = [
	new Promise((resolve) => (globalThis.sendFirstAwaitValue = resolve)),
	new Promise((resolve) => (globalThis.sendSecondAwaitValue = resolve)),
];
globalThis.suspendedAwaitResult = consumedAwaits();
globalThis.sendFirstAwaitValue({ value: 456 });
globalThis.sendFirstAwaitValue = undefined;
setTimeout(() => {
	globalThis.awaitGates[0] = undefined;
	gc();
	if (
		typeof globalThis.__mal_collect_garbage === "function" &&
		globalThis.awaitReference.deref() !== undefined
	)
		throw new Error("Suspended await output retained its previous input");
	globalThis.consumeAwaitValue = () => {};
	globalThis.sendSecondAwaitValue();
	globalThis.sendSecondAwaitValue = undefined;
	globalThis.suspendedAwaitResult.then((value) => console.log("await-output", value));
}, 0);
