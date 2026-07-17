import asyncHooks, { AsyncResource } from "node:async_hooks";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(AsyncResource.name === "AsyncResource", "constructor name");
check(asyncHooks.AsyncResource === AsyncResource, "default module object");
check(AsyncResource.length === 1, "constructor length");
check(
	AsyncResource.prototype.runInAsyncScope.name === "runInAsyncScope" &&
		AsyncResource.prototype.runInAsyncScope.length === 2,
	"method name and length",
);

const constructorName = Object.getOwnPropertyDescriptor(AsyncResource, "name");
const constructorLength = Object.getOwnPropertyDescriptor(AsyncResource, "length");
const constructorPrototype = Object.getOwnPropertyDescriptor(AsyncResource, "prototype");
const prototypeConstructor = Object.getOwnPropertyDescriptor(
	AsyncResource.prototype,
	"constructor",
);
const runDescriptor = Object.getOwnPropertyDescriptor(
	AsyncResource.prototype,
	"runInAsyncScope",
);
check(
	constructorName.value === "AsyncResource" &&
		constructorName.writable === false &&
		constructorName.enumerable === false &&
		constructorName.configurable === true,
	"constructor name descriptor",
);
check(
	constructorLength.value === 1 &&
		constructorLength.writable === false &&
		constructorLength.enumerable === false &&
		constructorLength.configurable === true,
	"constructor length descriptor",
);
check(
	constructorPrototype.value === AsyncResource.prototype &&
		constructorPrototype.writable === false &&
		constructorPrototype.enumerable === false &&
		constructorPrototype.configurable === false,
	"constructor prototype descriptor",
);
check(
	prototypeConstructor.value === AsyncResource &&
		prototypeConstructor.writable === true &&
		prototypeConstructor.enumerable === false &&
		prototypeConstructor.configurable === true,
	"prototype constructor descriptor",
);
check(
	runDescriptor.value === AsyncResource.prototype.runInAsyncScope &&
		runDescriptor.writable === true &&
		runDescriptor.enumerable === false &&
		runDescriptor.configurable === true,
	"method descriptor",
);

const resource = new AsyncResource("fixture");
check(resource instanceof AsyncResource, "constructed instance");
const thisArg = { base: 4 };
let observed = false;
const result = resource.runInAsyncScope(
	function (a, b, c) {
		observed = this === thisArg && a === 1 && b === 2 && c === 3;
		return this.base + a + b + c;
	},
	thisArg,
	1,
	2,
	3,
);
check(observed && result === 10, "forwards this, arguments, and return value");

const sentinel = { sentinel: true };
let abrupt;
try {
	resource.runInAsyncScope(() => {
		throw sentinel;
	});
} catch (error) {
	abrupt = error;
}
check(abrupt === sentinel, "preserves abrupt completion");

let bareCallError = false;
try {
	AsyncResource("fixture");
} catch (error) {
	bareCallError = error instanceof TypeError;
}
check(bareCallError, "requires construction");

let typeError = false;
try {
	new AsyncResource(1);
} catch (error) {
	typeError = error instanceof TypeError;
}
check(typeError, "validates type");

let callbackError = false;
try {
	resource.runInAsyncScope(1);
} catch (error) {
	callbackError = error instanceof TypeError;
}
check(callbackError, "validates callback");

let brandError = false;
try {
	AsyncResource.prototype.runInAsyncScope.call(
		Object.create(AsyncResource.prototype),
		() => 1,
	);
} catch (error) {
	brandError = error instanceof TypeError;
}
check(brandError, "rejects prototype-spoofed receiver");

class DerivedResource extends AsyncResource {}
const derived = new DerivedResource("derived");
check(
	derived instanceof DerivedResource &&
		derived instanceof AsyncResource &&
		derived.runInAsyncScope((value) => value + 1, undefined, 6) === 7,
	"supports derived construction",
);

function PrimitivePrototypeTarget() {}
PrimitivePrototypeTarget.prototype = 1;
const primitivePrototype = Reflect.construct(
	AsyncResource,
	["primitive-prototype"],
	PrimitivePrototypeTarget,
);
check(
	Object.getPrototypeOf(primitivePrototype) === Object.prototype,
	"primitive newTarget prototype uses Object.prototype",
);

let stressTotal = 0;
for (let i = 0; i < 100; i++) {
	const current = new AsyncResource("stress");
	stressTotal += current.runInAsyncScope((value) => ({ value }).value, null, i);
}
check(stressTotal === 4950, "repeated allocation and invocation");

console.log("RESULT " + passed + "/" + total);
