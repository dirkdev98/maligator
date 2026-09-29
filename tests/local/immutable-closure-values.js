"use strict";

function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

globalThis.makeImmutableValues = function makeImmutableValues(seed) {
	const value = seed;
	const object = { value: seed, nested: { value: seed + 1 } };
	const label = "value:" + seed;
	return {
		read: function immutablePrimitive() {
			return value;
		},
		object: function immutableObject() {
			return object;
		},
		alias: function immutableAlias() {
			return object;
		},
		pair: function immutablePair() {
			return [object, label];
		},
		defaults: function immutableDefault(argument = value) {
			return argument + value;
		},
	};
};

const first = globalThis.makeImmutableValues(7);
const second = globalThis.makeImmutableValues(20);
check("escaped primitive capture", first.read(), 7);
check("separate immutable activations", second.read(), 20);
check("separate function identities", first.read === second.read, false);
check("shared immutable object binding", first.object(), first.alias());
check("separate captured objects", first.object() === second.object(), false);
check("two captured values preserve object identity", first.pair()[0], first.object());
check("two captured values preserve string", first.pair()[1], "value:7");
first.object().nested.value = 91;
check(
	"immutable binding retains mutable object identity",
	first.alias().nested.value,
	91,
);
check("other activation object stays separate", second.object().nested.value, 21);
check("capture in default initializer", first.defaults(), 14);
check("undefined argument selects captured default", second.defaults(undefined), 40);
check("generic call preserves string addition", first.defaults("prefix"), "prefix7");
check("captured default preserves function length", first.defaults.length, 0);

const callbacks = [first.read, second.read];
check("dynamic array dispatch reads first value", callbacks[0](), 7);
check("dynamic array dispatch reads second value", callbacks[1](), 20);
check(
	"generic call receiver does not replace lexical value",
	first.read.call({ value: 99 }),
	7,
);

// Only the escaped functions retain these objects after their creators return.
// Stress-mode execution collects at safepoints while this loop creates garbage.
let checksum = 0;
for (let i = 0; i < 600; i++) {
	const temporary = globalThis.makeImmutableValues(i);
	checksum += temporary.read();
	check("temporary object identity", temporary.pair()[0], temporary.alias());
}
check("immutable creation checksum", checksum, 179700);
check(
	"escaped object survives allocation and collection",
	first.object().nested.value,
	91,
);
check("escaped string survives allocation and collection", first.pair()[1], "value:7");
check("second activation survives allocation and collection", second.read(), 20);

function makeBeforeInitialization(seed) {
	const read = function beforeInitialization() {
		return value;
	};
	let sawTdz = false;
	try {
		read();
	} catch (error) {
		sawTdz = error instanceof ReferenceError;
	}
	const value = { value: seed };
	return { read, sawTdz };
}
const early = makeBeforeInitialization(31);
check("creation before const initialization stays legal", early.sawTdz, true);
check("early closure observes later initialization", early.read().value, 31);

function makeMutableValues(seed) {
	let value = seed;
	return {
		read: function mutableValue() {
			return value;
		},
		write: function writeMutableValue(next) {
			value = next;
		},
	};
}
const mutableFirst = makeMutableValues(1);
const mutableSecond = makeMutableValues(2);
mutableFirst.write({ value: 42 });
check("mutable binding shares replacement with sibling", mutableFirst.read().value, 42);
check("mutable activations remain distinct", mutableSecond.read(), 2);
mutableFirst.write(5);
check("mutable binding never snapshots the initial value", mutableFirst.read(), 5);

function makeRecursiveValue(seed) {
	const value = { value: seed };
	const recurse = function recursiveValue(depth) {
		return depth === 0 ? value : recurse(depth - 1);
	};
	return recurse;
}
const recursiveFirst = makeRecursiveValue(51);
const recursiveSecond = makeRecursiveValue(61);
check("recursive capture keeps its activation", recursiveFirst(5).value, 51);
check(
	"recursive capture preserves object identity",
	recursiveFirst(2),
	recursiveFirst(4),
);
check("recursive activations remain distinct", recursiveSecond(3).value, 61);

console.log("immutable-closure-values PASS");
