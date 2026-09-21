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

let discardedSetterTotal = 0;
class GuardedObjectReturn {
	constructor(value) {
		this.discarded = value;
		return { value };
	}
}
const makeGuardedObjectReturns = function (limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		total += new GuardedObjectReturn(index).value;
	}
	return total;
};
ok("discarded receiver fast path", makeGuardedObjectReturns(4) === 6);
Object.defineProperty(GuardedObjectReturn.prototype, "discarded", {
	set(value) {
		discardedSetterTotal += value;
	},
});
ok(
	"discarded receiver guard miss",
	makeGuardedObjectReturns(4) === 6 && discardedSetterTotal === 6,
);

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

class ScalarPair {
	constructor(left, right) {
		this.left = left;
		this.right = right;
	}
}
const sumScalarPairs = function (limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const pair = new ScalarPair(index, index + 1);
		total += pair.left + pair.right;
	}
	return total;
};
ok("contained construction", sumScalarPairs(4) === 16);

let scalarSetterTotal = 0;
Object.defineProperty(ScalarPair.prototype, "left", {
	configurable: true,
	set(value) {
		scalarSetterTotal += value;
	},
});
ok(
	"prototype setter guard miss",
	Number.isNaN(sumScalarPairs(4)) && scalarSetterTotal === 6,
);

class LockedField {
	constructor(value) {
		this.value = value;
	}
}
const readLockedFields = function (limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const field = new LockedField(index);
		total += field.value;
	}
	return total;
};
Object.defineProperty(LockedField.prototype, "value", {
	value: 1,
	writable: false,
});
let sawLockedFieldError = false;
try {
	readLockedFields(2);
} catch (error) {
	sawLockedFieldError = error instanceof TypeError;
}
ok("non-writable prototype guard miss", sawLockedFieldError);

class InheritedRead {
	constructor(value) {
		this.value = value;
	}
}
InheritedRead.prototype.extra = 7;
const readInherited = function (limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const instance = new InheritedRead(index);
		total += instance.extra;
	}
	return total;
};
ok("inherited data read", readInherited(4) === 28);

class InheritedGetter {
	constructor(value) {
		this.value = value;
	}
}
let inheritedGetterReads = 0;
Object.defineProperty(InheritedGetter.prototype, "extra", {
	get() {
		inheritedGetterReads++;
		return 9;
	},
});
const readInheritedGetter = function (limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const instance = new InheritedGetter(index);
		total += instance.extra;
	}
	return total;
};
ok("inherited getter read", readInheritedGetter(4) === 36 && inheritedGetterReads === 4);

class ConstructorRead {
	constructor(value) {
		this.value = value;
	}
}
const readConstructor = function (limit) {
	let matches = 0;
	for (let index = 0; index < limit; index++) {
		const instance = new ConstructorRead(index);
		if (instance.constructor === ConstructorRead) matches++;
	}
	return matches;
};
ok("constructor identity read", readConstructor(4) === 4);

class StoredNewTarget {
	constructor() {
		this.target = new.target;
	}
}
ok("stored direct new.target", new StoredNewTarget().target === StoredNewTarget);

class ReturnedNewTarget {
	constructor() {
		return new.target;
	}
}
ok("returned direct new.target", new ReturnedNewTarget() === ReturnedNewTarget);

let dynamicReturnEffects = 0;
const dynamicThrowMarker = {};
const dynamicThrown = {};
class DynamicReturn {
	constructor(returned) {
		dynamicReturnEffects++;
		if (returned === dynamicThrowMarker) throw dynamicThrown;
		this.value = returned;
		return returned;
	}
}
const dynamicPrimitives = [undefined, null, false, 0, "", 0n, Symbol("value")];
for (let index = 0; index < dynamicPrimitives.length; index++) {
	const primitive = dynamicPrimitives[index];
	const result = new DynamicReturn(primitive);
	ok(
		"dynamic primitive return " + index,
		result instanceof DynamicReturn && result.value === primitive,
	);
}
const dynamicObjects = [{}, [], function returnedFunction() {}, new Proxy({}, {})];
for (let index = 0; index < dynamicObjects.length; index++) {
	const object = dynamicObjects[index];
	ok("dynamic object return " + index, new DynamicReturn(object) === object);
}
let sawDynamicThrow = false;
try {
	new DynamicReturn(dynamicThrowMarker);
} catch (error) {
	sawDynamicThrow = error === dynamicThrown;
}
ok("dynamic return throw", sawDynamicThrow);
ok("dynamic return side effects", dynamicReturnEffects === 12);

ok("check count", checks === 37);
console.log("direct-known-construct PASS");
