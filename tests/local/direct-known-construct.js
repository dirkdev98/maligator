const Probe = function Probe() {
	if (Probe !== new.target) throw new Error("direct constructor identity");
	return { probe: 277 };
};

const FallbackProbe = function FallbackProbe() {
	return { fallback: true };
};

let checks = 0;
const ok = function (name, condition) {
	if (!condition) throw new Error("direct-known-construct failure: " + name);
	checks++;
};

const order = [];
const mark = function (value) {
	order.push(value);
	return value;
};
const Ordered = function Ordered(left, right) {
	this.value = left * 10 + right;
};
const ordered = new Ordered(mark(1), mark(2));
ok("argument order", ordered.value === 12 && order.join(",") === "1,2");

const makeCaptured = function (captured) {
	const Capturing = function Capturing(value) {
		this.value = captured + value;
		this.newTarget = new.target;
	};
	const instance = new Capturing(2);
	return [instance, Capturing];
};
const firstCaptured = makeCaptured(100);
ok("first capture", firstCaptured[0].value === 102);
ok("first new.target identity", firstCaptured[0].newTarget === firstCaptured[1]);
const secondCaptured = makeCaptured(200);
ok("second capture", secondCaptured[0].value === 202);
ok("second new.target identity", secondCaptured[0].newTarget === secondCaptured[1]);

const customPrototype = { marker: 41 };
const CustomPrototype = function CustomPrototype() {};
CustomPrototype.prototype = customPrototype;
ok("custom prototype", Object.getPrototypeOf(new CustomPrototype()) === customPrototype);

const PrimitiveReturn = function PrimitiveReturn() {
	this.kind = "instance";
	return 1;
};
const ObjectReturn = function ObjectReturn() {
	this.kind = "discarded";
	return { kind: "object" };
};
ok("primitive return substitution", new PrimitiveReturn().kind === "instance");
ok("object return substitution", new ObjectReturn().kind === "object");

let Derived;
class Base {
	constructor(value) {
		this.base = value;
		this.newTarget = new.target;
	}
}
Derived = class Derived extends Base {
	constructor(value) {
		super(value);
		this.derived = value + 1;
	}
};
const base = new Base(3);
ok("base class constructor", base.base === 3 && base.newTarget === Base);
const derived = new Derived(7);
ok(
	"class and derived constructor",
	derived instanceof Base &&
		derived instanceof Derived &&
		derived.base === 7 &&
		derived.derived === 8 &&
		derived.newTarget === Derived,
);

class PrimitiveDerived extends Base {
	constructor() {
		super(1);
		return 1;
	}
}
let sawDerivedPrimitiveError = false;
try {
	new PrimitiveDerived();
} catch (error) {
	sawDerivedPrimitiveError = error instanceof TypeError;
}
ok("derived primitive return", sawDerivedPrimitiveError);

class ObjectDerived extends Base {
	constructor() {
		return { kind: "derived object" };
	}
}
ok("derived object return", new ObjectDerived().kind === "derived object");

const prototypeError = { marker: "prototype" };
const ThrowTarget = function ThrowTarget() {};
const ThrowingPrototype = new Proxy(ThrowTarget, {
	get(target, key, receiver) {
		if (key === "prototype") throw prototypeError;
		return Reflect.get(target, key, receiver);
	},
});
let sawPrototypeError = false;
try {
	new ThrowingPrototype();
} catch (error) {
	sawPrototypeError = error === prototypeError;
}
ok("throwing prototype lookup", sawPrototypeError);

const Recursive = function () {
	new Recursive();
};
let overflowed = false;
try {
	new Recursive();
} catch (error) {
	overflowed = error instanceof RangeError;
}
ok("recursion overflow", overflowed);

ok("check count", checks === 14);
console.log("direct-known-construct PASS");
