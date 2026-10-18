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

console.log("native-constructor-prototypes PASS");
