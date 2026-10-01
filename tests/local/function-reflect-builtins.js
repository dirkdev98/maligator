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

function captureBound(...values) {
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
	return { receiver: this, values };
}

function BoundRecord(...values) {
	if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
	this.values = values;
	this.target = new.target;
}

for (const depth of [1, 2, 8, 32]) {
	for (const arity of [0, 7, 8, 9, 15, 16, 17, 32]) {
		const receiver = { depth, arity };
		const values = Array.from({ length: arity }, (_, index) => ({ index }));
		for (const hasPrefix of [false, true]) {
			const prefix = hasPrefix ? values.slice(0, Math.max(0, arity - 1)) : [];
			const tail = values.slice(prefix.length);
			let callable = captureBound.bind(receiver, ...prefix);
			let constructor = BoundRecord.bind(receiver, ...prefix);
			for (let layer = 1; layer < depth; layer++) {
				callable = callable.bind({ layer });
				constructor = constructor.bind({ layer });
			}
			const result = callable(...tail);
			assert(result.receiver === receiver, "innermost bound receiver");
			assert(
				result.values.length === arity &&
					result.values.every((value, index) => value === values[index]),
				"bound call preserves zero, inline and allocated argument lists",
			);
			const instance = new constructor(...tail);
			assert(
				instance instanceof BoundRecord && instance !== receiver,
				"bound construction ignores receiver",
			);
			assert(instance.target === BoundRecord, "bound construction resolves new.target");
			assert(
				instance.values.length === arity &&
					instance.values.every((value, index) => value === values[index]),
				"bound construction preserves zero, inline and allocated argument lists",
			);
		}
	}
}

const nestedReceiver = {};
const nestedValues = Array.from({ length: 16 }, (_, index) => ({ index }));
const orderedBound = captureBound
	.bind(nestedReceiver, ...nestedValues.slice(0, 3))
	.bind({ ignored: 1 })
	.bind({ ignored: 2 }, ...nestedValues.slice(3, 11));
const orderedResult = orderedBound(...nestedValues.slice(11));
assert(
	orderedResult.receiver === nestedReceiver,
	"mixed bound chain keeps innermost receiver",
);
assert(
	orderedResult.values.every((value, index) => value === nestedValues[index]) &&
		orderedResult.values.length === 16,
	"inner prefix precedes outer prefix and incoming arguments",
);

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

function strictArguments() {
	"use strict";
	return arguments;
}
function mappedArguments(first, second) {
	return arguments;
}
function nonsimpleArguments(first = 1) {
	return arguments;
}
const originalValues = Array.prototype.values;
const originalIterator = Object.getOwnPropertyDescriptor(
	Array.prototype,
	Symbol.iterator,
);
let inheritedReads = 0;
let inheritedWrites = 0;
let iteratorReads = 0;
let strictList;
let mappedList;
try {
	Object.defineProperty(Object.prototype, "0", {
		configurable: true,
		get() {
			inheritedReads++;
			return 91;
		},
		set() {
			inheritedWrites++;
		},
	});
	Object.defineProperty(Object.prototype, "1", {
		configurable: true,
		value: 92,
		writable: false,
	});
	Object.defineProperty(Array.prototype, Symbol.iterator, {
		configurable: true,
		get() {
			iteratorReads++;
			throw new Error("mutable array iterator must not be read");
		},
	});
	Array.prototype.values = () => {
		throw new Error("replacement values");
	};
	strictList = strictArguments(7, undefined, { retained: true });
	mappedList = mappedArguments(8, 9);
	assert(
		strictList[0] === 7 && strictList[1] === undefined,
		"unmapped own indices bypass prototypes",
	);
	assert(
		mappedList[0] === 8 && mappedList[1] === 9,
		"mapped own indices bypass prototypes",
	);
	assert(
		strictList[Symbol.iterator] === originalValues,
		"unmapped intrinsic iterator identity",
	);
	assert(
		mappedList[Symbol.iterator] === originalValues,
		"mapped intrinsic iterator identity",
	);
	assert(
		inheritedReads === 0 && inheritedWrites === 0 && iteratorReads === 0,
		"arguments initialization runs no prototype hooks",
	);
	delete strictList[0];
	assert(
		strictList[0] === 91 && inheritedReads === 1,
		"deleted argument exposes inherited getter",
	);
} finally {
	delete Object.prototype[0];
	delete Object.prototype[1];
	Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
	Array.prototype.values = originalValues;
}
const indexDescriptor = Object.getOwnPropertyDescriptor(mappedList, "0");
assert(
	indexDescriptor.writable && indexDescriptor.enumerable && indexDescriptor.configurable,
	"arguments index attributes",
);
assert(
	strictList[2].retained && !Array.isArray(strictList),
	"escaped arguments retain heap values and ordinary identity",
);
strictList[10] = 10;
assert(strictList.length === 3, "indexed argument writes preserve ordinary length");
assert(
	Reflect.ownKeys(mappedList).map(String).join(",") ===
		"0,1,length,callee,Symbol(Symbol.iterator)",
	"arguments own-key order",
);
const emptyArguments = strictArguments();
assert(
	emptyArguments.length === 0 && emptyArguments[Symbol.iterator] === originalValues,
	"empty arguments metadata",
);
const calleeDescriptor = Object.getOwnPropertyDescriptor(emptyArguments, "callee");
assert(
	!calleeDescriptor.configurable &&
		!calleeDescriptor.enumerable &&
		typeof calleeDescriptor.get === "function",
	"strict callee is poisoned",
);
let calleeThrows = false;
try {
	emptyArguments.callee;
} catch (error) {
	calleeThrows = error instanceof TypeError;
}
assert(calleeThrows, "strict callee throws");
const defaultArguments = nonsimpleArguments();
const undefinedArguments = nonsimpleArguments(undefined);
assert(defaultArguments.length === 0, "defaults preserve omitted arguments length");
assert(
	undefinedArguments.length === 1 && undefinedArguments[0] === undefined,
	"defaults preserve the supplied arguments snapshot",
);
let defaultCalleeThrows = false;
try {
	defaultArguments.callee;
} catch (error) {
	defaultCalleeThrows = error instanceof TypeError;
}
assert(defaultCalleeThrows, "sloppy nonsimple parameters use unmapped arguments");

for (const count of [0, 1, 8, 9, 16, 65]) {
	for (const factory of [strictArguments, mappedArguments]) {
		const input = Array.from({ length: count }, (_, index) => ({ index, count }));
		const list = Reflect.apply(factory, undefined, input);
		input.length = 0;
		if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
		assert(list.length === count, "materialized arguments preserve supplied count");
		assert(
			Object.keys(list).join(",") ===
				Array.from({ length: count }, (_, index) => String(index)).join(","),
			"materialized arguments enumerate every index in order",
		);
		for (let index = 0; index < count; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
			assert(
				descriptor.writable &&
					descriptor.enumerable &&
					descriptor.configurable &&
					descriptor.value.index === index &&
					descriptor.value.count === count,
				"materialized arguments retain heap values and default index attributes",
			);
		}
		if (count > 0) {
			Object.defineProperty(list, "0", { value: "locked", writable: false });
			Object.freeze(list);
			assert(
				list[0] === "locked" && !Object.getOwnPropertyDescriptor(list, "0").writable,
				"materialized arguments preserve later descriptor transitions",
			);
		}
	}
}

console.log("function-reflect-builtins PASS");
