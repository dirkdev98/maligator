"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
	}
}

class Vec {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	add(other) {
		return new Vec(this.x + other.x, this.y + other.y);
	}
}

class Labeled extends Vec {
	constructor(x, y, label) {
		super(x, y);
		this.label = label;
	}
}

let sum = new Vec(0, 0);
const retained = [];
for (let i = 0; i < 20_000; i++) {
	sum = sum.add(new Vec(1, 2));
	if (i % 1000 === 0) retained.push(sum);
}
expectValue(sum.x + sum.y, 60_000, "class instances built in a loop");
for (const vec of retained)
	expectValue(
		Object.getPrototypeOf(vec),
		Vec.prototype,
		"instances keep the class prototype",
	);

const labeled = new Labeled(1, 2, "a");
expectValue(
	Object.getPrototypeOf(labeled),
	Labeled.prototype,
	"a derived class prototype",
);
expectValue(labeled instanceof Vec, true, "derived instances inherit");

const other = Reflect.construct(Vec, [3, 4], Labeled);
expectValue(
	Object.getPrototypeOf(other),
	Labeled.prototype,
	"newTarget supplies the prototype",
);
expectValue(
	Object.getPrototypeOf(new Vec(5, 6)),
	Vec.prototype,
	"and does not stick to Vec",
);

function Legacy(value) {
	this.value = value;
}
const first = new Legacy(1);
const replacement = { replaced: true };
Legacy.prototype = replacement;
const second = new Legacy(2);
expectValue(
	Object.getPrototypeOf(first) === replacement,
	false,
	"earlier instances keep theirs",
);
expectValue(Object.getPrototypeOf(second), replacement, "a writable prototype is reread");
Legacy.prototype = 42;
expectValue(
	Object.getPrototypeOf(new Legacy(3)),
	Object.prototype,
	"a non-object prototype falls back to Object.prototype",
);

let created = 0;
for (let round = 0; round < 5; round++) {
	class Local {
		constructor() {
			created++;
		}
	}
	for (let i = 0; i < 100; i++)
		expectValue(
			Object.getPrototypeOf(new Local()),
			Local.prototype,
			"a fresh class per round",
		);
}
expectValue(created, 500, "every construction ran");

class Cell {
	constructor(value) {
		this.value = value;
		this.next = null;
	}
	link(value) {
		const cell = new Cell(value);
		cell.next = this;
		return cell;
	}
}
let head = new Cell(0);
for (let i = 1; i <= 100; i++) head = head.link(i);
expectValue(
	head.value + head.next.value,
	199,
	"inlined constructions initialize their fields",
);
let intercepted = 0;
Object.defineProperty(Cell.prototype, "next", {
	set() {
		intercepted++;
	},
	configurable: true,
});
const linked = head.link(101);
expectValue(intercepted, 2, "an inherited setter sees both stores once batching stops");
expectValue(
	Object.hasOwn(linked, "next"),
	false,
	"the setter, not a field, received next",
);

const closeOperations = [
	["prevent", Object.preventExtensions],
	["seal", Object.seal],
	["freeze", Object.freeze],
	["reflect", Reflect.preventExtensions],
];
const prototypeFactories = [
	["ordinary", () => function ordinary() {}],
	["generator", () => function* generator() {}],
	["async generator", () => async function* asyncGenerator() {}],
];
for (const [operation, close] of closeOperations) {
	for (const [kind, create] of prototypeFactories) {
		for (const wrapped of [false, true]) {
			const target = create();
			const receiver = wrapped ? new Proxy(new Proxy(target, {}), {}) : target;
			expectValue(
				close(receiver),
				operation === "reflect" ? true : receiver,
				"close result",
			);
			expectValue(Object.isExtensible(target), false, "function is closed");
			expectValue(
				Object.getOwnPropertyNames(target).includes("prototype"),
				true,
				"untouched prototype remains an own property",
			);
			const descriptor = Object.getOwnPropertyDescriptor(target, "prototype");
			expectValue(descriptor.enumerable, false, "prototype is not enumerable");
			expectValue(descriptor.configurable, false, "prototype is not configurable");
			expectValue(
				descriptor.writable,
				operation !== "freeze",
				"prototype writability follows integrity",
			);
			const prototype = descriptor.value;
			expectValue(target.prototype, prototype, "prototype identity is stable");
			expectValue(
				Object.hasOwn(prototype, "constructor"),
				kind === "ordinary",
				"function kind controls the constructor backlink",
			);
			if (kind === "ordinary") {
				expectValue(prototype.constructor, target, "ordinary constructor backlink");
				expectValue(
					Object.getPrototypeOf(new target()),
					prototype,
					"closed constructor still constructs",
				);
			} else {
				expectValue(
					Object.getPrototypeOf(prototype),
					Object.getPrototypeOf(target).prototype,
					"generator prototype parent",
				);
				expectValue(
					Object.getPrototypeOf(target()),
					prototype,
					"generator keeps its prototype",
				);
			}
		}
	}
	for (const create of [
		() => () => {},
		() => async function asyncFunction() {},
		() => ({ method() {} }).method,
		() => function boundTarget() {}.bind(null),
	]) {
		const target = create();
		close(target);
		expectValue(
			Object.hasOwn(target, "prototype"),
			false,
			"closing does not invent a prototype",
		);
	}
	const replaced = function replaced() {};
	const replacement = {};
	replaced.prototype = replacement;
	close(replaced);
	expectValue(replaced.prototype, replacement, "closing keeps an overridden prototype");
	let getterCalls = 0;
	const accessor = () => {};
	const getter = () => {
		getterCalls++;
		return replacement;
	};
	Object.defineProperty(accessor, "prototype", { get: getter, configurable: true });
	close(accessor);
	expectValue(getterCalls, 0, "closing does not call a prototype getter");
	expectValue(
		Object.getOwnPropertyDescriptor(accessor, "prototype").get,
		getter,
		"closing preserves the accessor",
	);
}
const denied = new Proxy(function denied() {}, {
	preventExtensions() {
		return false;
	},
});
expectValue(
	Reflect.preventExtensions(denied),
	false,
	"Reflect preserves a failed trap result",
);
for (const close of [Object.preventExtensions, Object.freeze, Object.seal]) {
	let threw = false;
	try {
		close(denied);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	expectValue(threw, true, "Object integrity operations reject a failed trap");
}
const forwarded = function forwarded() {};
const revocable = Proxy.revocable(forwarded, {
	get preventExtensions() {
		revocable.revoke();
		const padding = Array.from({ length: 30 }, (_, index) => ({ index }));
		expectValue(padding.length, 30, "trap lookup can allocate");
		return (target) => Reflect.preventExtensions(target);
	},
});
expectValue(
	Reflect.preventExtensions(revocable.proxy),
	true,
	"revocation during lookup keeps the captured target",
);
expectValue(Object.isExtensible(forwarded), false, "forwarded target is closed");
expectValue(
	Object.hasOwn(forwarded, "prototype"),
	true,
	"forwarded target retains its lazy prototype",
);

console.log("native-constructor-prototypes PASS");
