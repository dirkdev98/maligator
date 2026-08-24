function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function sum() {
	let total = 0;
	for (let i = 0; i < arguments.length; i++) total += arguments[i];
	return total;
}

const packed = [1, 2, 3, 4];
assert(sum.apply(null, packed) === 10, "Function.apply packed array");
assert(Reflect.apply(sum, null, packed) === 10, "Reflect.apply packed array");

const events = [];
const arrayLike = {
	get length() {
		events.push("length");
		return 3;
	},
	get 0() {
		events.push("0");
		return 4;
	},
	get 1() {
		events.push("1");
		return 5;
	},
	get 2() {
		events.push("2");
		return 6;
	},
};
assert(sum.apply(null, arrayLike) === 15, "Function.apply array-like");
assert(events.join(",") === "length,0,1,2", "Function.apply Get order");
events.length = 0;
assert(Reflect.apply(sum, null, arrayLike) === 15, "Reflect.apply array-like");
assert(events.join(",") === "length,0,1,2", "Reflect.apply Get order");

const holePrototype = {
	get 1() {
		events.push("hole");
		return 9;
	},
};
const holey = [1, , 3];
Object.setPrototypeOf(holey, holePrototype);
events.length = 0;
assert(Reflect.apply(sum, null, holey) === 13, "Reflect.apply inherited hole");
assert(events.join(",") === "hole", "Reflect.apply observes inherited hole");

const longArgs = { length: 10 };
for (let i = 0; i < 10; i++) longArgs[i] = i + 1;
assert(Reflect.apply(sum, null, longArgs) === 55, "Reflect.apply owned buffer");

function Pair(x, y) {
	this.total = x + y;
}
const pair = Reflect.construct(Pair, [7, 8]);
assert(pair.total === 15 && pair instanceof Pair, "Reflect.construct packed array");
const alternatePrototype = { alternate: true };
function Alternate() {}
Alternate.prototype = alternatePrototype;
const alternate = Reflect.construct(Pair, [2, 3], Alternate);
assert(
	Object.getPrototypeOf(alternate) === alternatePrototype && alternate.total === 5,
	"Reflect.construct newTarget",
);

const bind = Function.prototype.bind;
function target(a, b, c, d) {
	return a + b + c + d;
}
const bound = bind.call(target, null, 1, 2);
assert(bound.length === 2, "bind length");
assert(bound.name === "bound target", "bind name");
assert(bound(3, 4) === 10, "bind call");

const metadataEvents = [];
function metadataTarget(a, b, c, d, e) {
	return a + b + c + d + e;
}
Object.defineProperty(metadataTarget, "length", {
	configurable: true,
	get() {
		metadataEvents.push("length");
		return 5;
	},
});
Object.defineProperty(metadataTarget, "name", {
	configurable: true,
	get() {
		metadataEvents.push("name");
		return "metadata";
	},
});
const metadataBound = bind.call(metadataTarget, null, 1, 2);
assert(metadataBound.length === 3, "bind accessor length");
assert(metadataBound.name === "bound metadata", "bind accessor name");
assert(metadataEvents.join(",") === "length,name", "bind metadata order");

function noPrototype() {}
Object.setPrototypeOf(noPrototype, null);
const nullPrototypeBound = bind.call(noPrototype, null);
assert(Object.getPrototypeOf(nullPrototypeBound) === null, "bind null prototype");

let prototypeTrapCount = 0;
const customFunctionPrototype = {};
const proxyTarget = new Proxy(target, {
	getPrototypeOf() {
		prototypeTrapCount++;
		return customFunctionPrototype;
	},
});
const proxyBound = bind.call(proxyTarget, null, 1);
assert(
	Object.getPrototypeOf(proxyBound) === customFunctionPrototype,
	"bind proxy prototype",
);
assert(prototypeTrapCount === 1, "bind invokes proxy getPrototypeOf once");

const nested = bind.call(bind.call(sum, null, 1, 2, 3, 4), null, 5, 6, 7, 8);
assert(nested(9, 10) === 55, "nested bind merged arguments");

const targetText = Function.prototype.toString.call(target);
assert(targetText === "function target() { [native code] }", "Function.toString result");

const receiver = { marker: 42 };
const getterTarget = {
	get value() {
		return this.marker;
	},
};
assert(Reflect.get(getterTarget, "value", receiver) === 42, "Reflect.get receiver");
assert(Reflect.has(getterTarget, "value"), "Reflect.has");

const setterTarget = {
	set value(next) {
		this.marker = next;
	},
};
assert(Reflect.set(setterTarget, "value", 77, receiver), "Reflect.set success");
assert(receiver.marker === 77, "Reflect.set receiver");

const descriptorTarget = {};
assert(
	Reflect.defineProperty(descriptorTarget, "x", {
		value: 1,
		writable: false,
		configurable: false,
	}),
	"Reflect.defineProperty success",
);
const descriptor = Reflect.getOwnPropertyDescriptor(descriptorTarget, "x");
assert(descriptor.value === 1 && descriptor.writable === false, "Reflect descriptor");
assert(
	!Reflect.deleteProperty(descriptorTarget, "x"),
	"Reflect.deleteProperty rejection",
);
assert(Reflect.isExtensible(descriptorTarget), "Reflect.isExtensible");
assert(Reflect.preventExtensions(descriptorTarget), "Reflect.preventExtensions");
assert(!Reflect.isExtensible(descriptorTarget), "Reflect.preventExtensions result");
assert(
	!Reflect.defineProperty(descriptorTarget, "y", { value: 2 }),
	"Reflect define rejection",
);

const prototypeTarget = {};
const nextPrototype = {};
assert(Reflect.setPrototypeOf(prototypeTarget, nextPrototype), "Reflect.setPrototypeOf");
assert(
	Reflect.getPrototypeOf(prototypeTarget) === nextPrototype,
	"Reflect.getPrototypeOf",
);

const symbol = Symbol("key");
const keyTarget = { 2: true, alpha: true };
keyTarget[symbol] = true;
assert(
	Reflect.ownKeys(keyTarget).map(String).join(",") === "2,alpha,Symbol(key)",
	"Reflect.ownKeys order",
);

function lazyPrototype() {}
const functionKeys = Reflect.ownKeys(lazyPrototype);
assert(
	functionKeys.includes("prototype"),
	"Reflect.ownKeys materializes function prototype",
);

console.log("function-reflect-builtins PASS");
