let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("function-call-direct failure: " + name);
	checks++;
}

const order = [];
function mark(value) {
	order.push(value);
	return value;
}

const strictTarget = function strictTarget(left, right) {
	"use strict";
	return [this, left, right];
};
const strictResult = strictTarget.call(null, mark(1), mark(2));
ok(
	"strict this and arguments",
	strictResult[0] === null && strictResult[1] === 1 && strictResult[2] === 2,
);
ok("argument order", order.join(",") === "1,2");

const sloppyTarget = function sloppyTarget() {
	return this;
};
ok("sloppy undefined this", sloppyTarget.call(undefined) === globalThis);
ok("sloppy primitive this", sloppyTarget.call(3).valueOf() === 3);

function makeCaptured(base) {
	const captured = function captured(value) {
		"use strict";
		return this.offset + base + value;
	};
	return captured.call({ offset: 2 }, 3);
}
ok("capture", makeCaptured(5) === 10);

const ownOverrideTarget = function ownOverrideTarget() {
	return "target";
};
ownOverrideTarget.call = function ownCall(value) {
	return this === ownOverrideTarget ? "own:" + value : "bad";
};
ok("own override fallback", ownOverrideTarget.call(null, "value") === "own:null");

const originalCall = Function.prototype.call;
Function.prototype.call = function poisonedCall() {
	return this === strictTarget ? "poisoned" : "bad";
};
ok("prototype override fallback", strictTarget.call(null, 1, 2) === "poisoned");
Function.prototype.call = originalCall;

const mutationOrder = [];
function mutateCall() {
	mutationOrder.push("this");
	Function.prototype.call = function lateOverride() {
		return "late";
	};
	return null;
}
function mutateArgument() {
	mutationOrder.push("arg");
	return 4;
}
const loadedBeforeMutation = strictTarget.call(mutateCall(), mutateArgument(), 5);
Function.prototype.call = originalCall;
ok(
	"method load and argument order",
	loadedBeforeMutation[0] === null &&
		loadedBeforeMutation[1] === 4 &&
		loadedBeforeMutation[2] === 5 &&
		mutationOrder.join(",") === "this,arg",
);

const nativeSlice = Array.prototype.slice;
ok("native target", nativeSlice.call([1, 2, 3], 1).join(",") === "2,3");

const boundBase = function boundBase(left, right) {
	"use strict";
	return this.name + left + right;
};
const bound = boundBase.bind({ name: "bound" }, ":");
ok("bound fallback", bound.call({ name: "ignored" }, "value") === "bound:value");

let proxyThis;
const proxy = new Proxy(strictTarget, {
	apply(target, thisValue, args) {
		proxyThis = thisValue;
		return Reflect.apply(target, thisValue, args);
	},
});
const proxyResult = proxy.call("proxy", 6, 7);
ok(
	"proxy fallback",
	proxyThis === "proxy" && proxyResult[1] === 6 && proxyResult[2] === 7,
);

const recursive = function recursive(value) {
	"use strict";
	return value === 0 ? this : recursive.call(this, value - 1);
};
const recursionThis = {};
ok("recursion", recursive.call(recursionThis, 20) === recursionThis);

const thrown = {};
const throwing = function throwing() {
	throw thrown;
};
let caught;
try {
	throwing.call(null);
} catch (error) {
	caught = error;
}
ok("target throw", caught === thrown);

ok("zero arguments", strictTarget.call()[0] === undefined);
class ConstructorOnly {}
let classError;
try {
	ConstructorOnly.call(null);
} catch (error) {
	classError = error;
}
ok("class rejects call", classError instanceof TypeError);
let nonCallableError;
try {
	originalCall.call(17);
} catch (error) {
	nonCallableError = error;
}
ok("non-callable rejects call", nonCallableError instanceof TypeError);

ok("check count", checks === 16);
console.log("function-call-direct PASS");
