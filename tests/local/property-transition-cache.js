function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function storeValue(object, value) {
	object.value = value;
}

function storeInheritedWritable(object, value) {
	object.inheritedWritable = value;
}

function storeIntercepted(object, value) {
	object.intercepted = value;
}

function storeReadOnlyStrict(object, value) {
	"use strict";
	object.readOnly = value;
}

function storeProxyIntercepted(object, value) {
	object.proxyIntercepted = value;
}

function storeComputed(object, key, value) {
	object[key] = value;
}

// A writable inherited data property permits OrdinarySet to create a default
// own data property on the receiver.
const writablePrototype = {};
Object.defineProperty(writablePrototype, "inheritedWritable", {
	value: 1,
	writable: true,
	configurable: true,
});
for (let i = 0; i < 4; i++) {
	const object = Object.create(writablePrototype);
	storeInheritedWritable(object, i + 10);
	assert(object.inheritedWritable === i + 10, "inherited writable value");
	assert(
		Object.prototype.hasOwnProperty.call(object, "inheritedWritable"),
		"inherited writable must create own",
	);
}

// Accessors and non-writable inherited data must continue through full [[Set]].
let setterTotal = 0;
const setterPrototype = {};
Object.defineProperty(setterPrototype, "intercepted", {
	set(value) {
		setterTotal += value;
	},
	configurable: true,
});
for (let i = 1; i <= 4; i++) {
	const object = Object.create(setterPrototype);
	storeIntercepted(object, i);
	assert(
		!Object.prototype.hasOwnProperty.call(object, "intercepted"),
		"setter store must not create own",
	);
}
assert(setterTotal === 10, "inherited setter must run");

const readOnlyPrototype = {};
Object.defineProperty(readOnlyPrototype, "readOnly", {
	value: 7,
	writable: false,
	configurable: true,
});
const readOnlyReceiver = Object.create(readOnlyPrototype);
assert(
	Reflect.set(readOnlyReceiver, "readOnly", 8) === false,
	"Reflect.set must report read-only rejection",
);
assert(readOnlyReceiver.readOnly === 7, "read-only assignment");
assert(
	!Object.prototype.hasOwnProperty.call(readOnlyReceiver, "readOnly"),
	"read-only assignment must not create own",
);
let strictThrew = false;
try {
	storeReadOnlyStrict(Object.create(readOnlyPrototype), 8);
} catch (error) {
	strictThrew = error instanceof TypeError;
}
assert(strictThrew, "strict read-only assignment must throw");

// An exotic prototype owns the [[Set]] decision and is never transition-cached.
let proxySetCalls = 0;
const proxyPrototype = new Proxy(
	{},
	{
		set(target, key, value, receiver) {
			proxySetCalls++;
			return Reflect.set(target, key, value, receiver);
		},
	},
);
for (let i = 0; i < 3; i++) {
	const object = Object.create(proxyPrototype);
	storeProxyIntercepted(object, i);
	assert(object.proxyIntercepted === i, "proxy prototype store");
}
assert(proxySetCalls === 3, "proxy prototype [[Set]] must run");

// Fresh equal computed strings converge on the VM atom and the same transition.
for (let i = 0; i < 8; i++) {
	const object = {};
	storeComputed(object, ["com", "puted"].join(""), i);
	assert(object.computed === i, "computed transition store");
}

// Alternating source shapes on the same chain may refill one monomorphic site
// without rebuilding its dependency registration. A later mutation must still
// invalidate the reused registration.
let thrashSetterTotal = 0;
const thrashPrototype = {};
function storeThrashingTransition(object, value) {
	object.thrashing = value;
}
for (let i = 0; i < 9; i++) {
	if (i === 8) {
		Object.defineProperty(thrashPrototype, "thrashing", {
			set(value) {
				thrashSetterTotal += value;
			},
			configurable: true,
		});
	}
	const object = Object.create(thrashPrototype);
	if (i % 2 === 1) object.prefix = 1;
	storeThrashingTransition(object, i);
	if (i < 8) {
		assert(object.thrashing === i, "same-chain transition refill");
	} else {
		assert(
			!Object.prototype.hasOwnProperty.call(object, "thrashing"),
			"same-chain reused dependency must invalidate",
		);
	}
}
assert(thrashSetterTotal === 8, "same-chain refill setter must run");

if (typeof globalThis.__mal_reset_perf_stats === "function") {
	globalThis.__mal_reset_perf_stats();
}

class PublicFields {
	first = 1;
	second = 2;
}

for (let i = 0; i < 16; i++) {
	const instance = new PublicFields();
	assert(instance.first + instance.second === 3, "cached public fields");
}

// One fill followed by fifteen old-shape -> child-shape hits.
for (let i = 0; i < 16; i++) {
	const object = {};
	storeValue(object, i);
	assert(object.value === i, "transition hit value");
}

// Mutation on an unrelated chain must not evict the transition row.
const localPrototype = {};
const unrelatedPrototype = {};
function storeLocal(object, value) {
	object.local = value;
}
for (let i = 0; i < 16; i++) {
	if (i === 1) {
		Object.defineProperty(unrelatedPrototype, "noise", {
			value: 1,
			configurable: true,
		});
	}
	const object = Object.create(localPrototype);
	storeLocal(object, i);
	assert(object.local === i, "chain-local transition validity");
}

// Mutation on the actual chain must invalidate the row before the next store.
let invalidatedSetterTotal = 0;
const invalidatedPrototype = {};
function storeInvalidated(object, value) {
	object.invalidated = value;
}
for (let i = 1; i <= 2; i++) {
	if (i === 2) {
		Object.defineProperty(invalidatedPrototype, "invalidated", {
			set(value) {
				invalidatedSetterTotal += value;
			},
			configurable: true,
		});
	}
	const object = Object.create(invalidatedPrototype);
	storeInvalidated(object, i);
	if (i === 1) {
		assert(object.invalidated === 1, "initial invalidated transition fill");
	} else {
		assert(
			!Object.prototype.hasOwnProperty.call(object, "invalidated"),
			"invalidated transition must defer to setter",
		);
	}
}
assert(invalidatedSetterTotal === 2, "post-fill prototype setter must run");

console.log("property-transition-cache PASS");
