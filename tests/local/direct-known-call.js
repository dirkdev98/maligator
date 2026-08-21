const directTarget = function directTarget(value, expected) {
	"use strict";
	value += 0;
	value += 1;
	value += 2;
	value += 3;
	value += 4;
	value += 5;
	value += 6;
	value += 7;
	value += 8;
	value += 9;
	value += 10;
	value += 11;
	value += 12;
	value += 13;
	value += 14;
	value += 15;
	value += 16;
	value += 17;
	value += 18;
	value += 19;
	value += 20;
	value += 21;
	value += 22;
	value += 23;
	if (directTarget !== expected || this !== undefined) return -1;
	return value;
};

let checks = 0;
const ok = function (name, condition) {
	if (!condition) throw new Error("direct-known-call failure: " + name);
	checks++;
};

const order = [];
const mark = function (value) {
	order.push(value);
	return value;
};
ok("large target", directTarget(mark(1), (mark(2), directTarget)) === 277);
ok("argument order", order.join(",") === "1,2");

let guardedHandler = (value) => value + 10;
const installGuardedHandler = function (other) {
	guardedHandler = other;
};
const guardedRun = function (value) {
	try {
		return guardedHandler(value) * 2;
	} catch (error) {
		return error.message;
	}
};
ok("guarded inline hit", guardedRun(5) === 30);
ok(
	"guarded inline throw",
	guardedRun({
		valueOf() {
			throw new Error("guarded inline throw");
		},
	}) === "guarded inline throw",
);
installGuardedHandler((value) => value + 20);
ok("guarded inline fallback", guardedRun(5) === 50);
installGuardedHandler(() => {
	throw new Error("guarded fallback throw");
});
ok("guarded fallback throw", guardedRun(5) === "guarded fallback throw");

const firstFiniteTarget = (value) => value + 100;
const secondFiniteTarget = (value) => value + 200;
let finiteHandler = firstFiniteTarget;
const selectFiniteHandler = function (second) {
	finiteHandler = second ? secondFiniteTarget : firstFiniteTarget;
};
const installFiniteHandler = function (other) {
	finiteHandler = other;
};
const finiteRun = function (value) {
	try {
		return finiteHandler(value) * 2;
	} catch (error) {
		return error.message;
	}
};
ok("first finite inline hit", finiteRun(5) === 210);
selectFiniteHandler(true);
ok("second finite inline hit", finiteRun(5) === 410);
ok(
	"finite inline throw",
	finiteRun({
		valueOf() {
			throw new Error("finite inline throw");
		},
	}) === "finite inline throw",
);
installFiniteHandler((value) => value + 300);
ok("finite generic fallback", finiteRun(5) === 610);
installFiniteHandler(() => {
	throw new Error("finite fallback throw");
});
ok("finite fallback throw", finiteRun(5) === "finite fallback throw");

const classCallMessage = "Class constructor cannot be invoked without 'new'";
const closedClassSemantics = function (value) {
	class ClosedClass {
		constructor(input) {
			return input + 1;
		}
	}
	let callError;
	try {
		ClosedClass(value);
	} catch (error) {
		callError = error;
	}
	const instance = new ClosedClass(value);
	return (
		callError instanceof TypeError &&
		callError.message === classCallMessage &&
		instance instanceof ClosedClass
	);
};
ok("closed class call throws", closedClassSemantics(1));

let MutableClass = class {
	constructor(value) {
		return value + 2;
	}
};
const installMutableClass = function (other) {
	MutableClass = other;
};
let mutableClassCallError;
let mutableClassArgumentEvaluated = false;
try {
	MutableClass(((mutableClassArgumentEvaluated = true), 1));
} catch (error) {
	mutableClassCallError = error;
}
ok(
	"open class call throws",
	mutableClassArgumentEvaluated &&
		mutableClassCallError instanceof TypeError &&
		mutableClassCallError.message === classCallMessage,
);
const mutableClassInstance = new MutableClass(1);
ok("open class constructs", mutableClassInstance instanceof MutableClass);

const classCallOrder = [];
const classHolder = {
	get target() {
		classCallOrder.push("callee");
		return MutableClass;
	},
};
const classReceiver = function () {
	classCallOrder.push("receiver");
	return classHolder;
};
let orderedClassCallError;
try {
	classReceiver().target((classCallOrder.push("argument"), 1));
} catch (error) {
	orderedClassCallError = error;
}
ok(
	"class call evaluation order",
	classCallOrder.join(",") === "receiver,callee,argument" &&
		orderedClassCallError instanceof TypeError &&
		orderedClassCallError.message === classCallMessage,
);

class RepeatedMutableClass {
	constructor(value) {
		return value + 3;
	}
}
installMutableClass(RepeatedMutableClass);
let repeatedClassThrows = 0;
for (let classCall = 0; classCall < 2; classCall++) {
	try {
		MutableClass(classCall);
	} catch (error) {
		if (error instanceof TypeError && error.message === classCallMessage) {
			repeatedClassThrows++;
		}
	}
}
ok("repeated class calls throw", repeatedClassThrows === 2);
const repeatedClassInstance = new MutableClass(1);
ok("repeated class constructs", repeatedClassInstance instanceof RepeatedMutableClass);

globalThis.invokeUnknown = function invokeUnknown(fn) {
	return fn();
};
let genericRepeatedClassThrows = 0;
for (let classCall = 0; classCall < 2; classCall++) {
	try {
		globalThis.invokeUnknown(RepeatedMutableClass);
	} catch (error) {
		if (error instanceof TypeError && error.message === classCallMessage) {
			genericRepeatedClassThrows++;
		}
	}
}
ok("generic repeated class calls throw", genericRepeatedClassThrows === 2);

installMutableClass((value) => value + 30);
ok("open class fallback", MutableClass(2) === 32);

const makeAndInvoke = function (captured) {
	const closure = function closure(value, expected) {
		"use strict";
		value += 0;
		value += 1;
		value += 2;
		value += 3;
		value += 4;
		value += 5;
		value += 6;
		value += 7;
		value += 8;
		value += 9;
		value += 10;
		value += 11;
		value += 12;
		value += 13;
		value += 14;
		value += 15;
		value += 16;
		value += 17;
		value += 18;
		value += 19;
		value += 20;
		value += 21;
		value += 22;
		value += 23;
		return closure === expected && this === undefined ? captured + value : -1;
	};
	return closure(1, closure);
};
ok("first capture", makeAndInvoke(1000) === 1277);
ok("second capture", makeAndInvoke(2000) === 2277);

const identityTarget = function identityTarget(expected) {
	return this === undefined && identityTarget === expected;
};
ok("this/callee identity", identityTarget(identityTarget));

const numericTarget = (value) => {
	const object = {
		f0: value,
		f1: value + 1,
		f2: value + 2,
		f3: value + 3,
		f4: value + 4,
		f5: value + 5,
		f6: value + 6,
		f7: value + 7,
		f8: value + 8,
		f9: value + 9,
		f10: value + 10,
		f11: value + 11,
		f12: value + 12,
		f13: value + 13,
		f14: value + 14,
		f15: value + 15,
	};
	if ((value & 2) === 0) object.f7 = object.f1 + object.f15;
	else object.f7 = object.f3 + object.f11;
	let result =
		object.f0 +
		object.f1 +
		object.f2 +
		object.f3 +
		object.f4 +
		object.f5 +
		object.f6 +
		object.f7;
	result +=
		object.f8 +
		object.f9 +
		object.f10 +
		object.f11 +
		object.f12 +
		object.f13 +
		object.f14 +
		object.f15;
	if (object !== object) result = 0;
	return result;
};
let nativeTotal = 0;
for (let nativeIndex = 0; nativeIndex < 4; nativeIndex++) {
	nativeTotal += numericTarget(nativeIndex);
}
ok("native numeric entry", nativeTotal === 614);
const missingNumericArgument = numericTarget();
ok("boxed argument fallback", missingNumericArgument !== missingNumericArgument);

const overflow = function overflow(depth) {
	return overflow(depth + 1) + 1;
};
let overflowed = false;
try {
	overflow(0);
} catch (error) {
	overflowed = error instanceof RangeError;
}
ok("overflow", overflowed);

ok("check count", checks === 25);
console.log("direct-known-call PASS");
