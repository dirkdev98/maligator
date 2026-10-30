function check(value, message) {
	if (!value) throw new Error(message);
}
const originalApply = Function.prototype.apply;
const collect =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function invoke(target, receiver, a, b) {
	return target.apply(receiver, [a, b]);
}
function describe(a, b) {
	"use strict";
	collect();
	return [this, arguments.length, a, b];
}
const receiver = { name: "receiver" };
const left = { name: "left" };
const right = { name: "right" };
for (let i = 0; i < 8; i++) {
	const result = invoke(describe, receiver, left, right);
	check(
		result[0] === receiver &&
			result[1] === 2 &&
			result[2] === left &&
			result[3] === right,
		"script receiver and live heap arguments",
	);
}
check(invoke(Math.max, null, 3, 7) === 7, "native target");
const bound = describe.bind(receiver, left);
const boundResult = invoke(bound, null, right, 9);
check(
	boundResult[0] === receiver &&
		boundResult[1] === 3 &&
		boundResult[2] === left &&
		boundResult[3] === right,
	"bound target",
);
const proxy = new Proxy(describe, {
	apply(target, thisArg, values) {
		check(
			thisArg === receiver && values[0] === left && values[1] === right,
			"proxy call arguments",
		);
		return Reflect.apply(target, thisArg, values);
	},
});
check(invoke(proxy, receiver, left, right)[2] === left, "callable proxy");
function overridden() {
	throw new Error("must use own apply");
}
overridden.apply = function (thisArg, values) {
	check(
		this === overridden && thisArg === receiver && Array.isArray(values),
		"override receives actual array and receiver",
	);
	collect();
	return values[0] === left && values[1] === right;
};
check(invoke(overridden, receiver, left, right), "own override");
const events = [];
const marked = (value) => {
	events.push(value);
	return value;
};
function ordered(target) {
	return target.apply(marked("this"), [marked("a"), marked("b")]);
}
function loaded() {
	"use strict";
	return this + arguments[0] + arguments[1];
}
Object.defineProperty(loaded, "apply", {
	configurable: true,
	get() {
		events.push("get");
		return originalApply;
	},
});
check(
	ordered(loaded) === "thisab" && events.join() === "get,this,a,b",
	"method and argument evaluation order",
);
function retained(target) {
	return target.apply(null, [((target.apply = () => "wrong"), left), right]);
}
delete loaded.apply;
check(
	retained(loaded) === "null[object Object][object Object]",
	"loaded method retained after element mutation",
);
let observed;
const object = { apply: originalApply };
try {
	invoke(object, null, 1, 2);
} catch (error) {
	observed = error;
}
check(observed instanceof TypeError, "noncallable receiver keeps builtin error");
class Constructor {}
try {
	invoke(Constructor, null, 1, 2);
	check(false, "class must throw");
} catch (error) {
	check(error instanceof TypeError, "class call error");
}
const revoked = Proxy.revocable(describe, {});
revoked.revoke();
try {
	invoke(revoked.proxy, null, 1, 2);
	check(false, "revoked proxy must throw");
} catch (error) {
	check(error instanceof TypeError, "revoked proxy error");
}
const sentinel = {};
function thrower() {
	throw sentinel;
}
try {
	invoke(thrower, receiver, left, right);
	check(false, "target must throw");
} catch (error) {
	check(error === sentinel, "throw identity");
}
const foreign = $262.createRealm().global;
const foreignObject = { apply: foreign.Function.prototype.apply };
try {
	invoke(foreignObject, null, 1, 2);
	check(false, "foreign noncallable must throw");
} catch (error) {
	check(
		Object.getPrototypeOf(error) === foreign.TypeError.prototype,
		"foreign apply error realm",
	);
}
const originalIterator = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () {
	throw new Error("apply must not iterate");
};
try {
	check(
		invoke(describe, receiver, left, right)[2] === left,
		"array iterator is irrelevant",
	);
} finally {
	Array.prototype[Symbol.iterator] = originalIterator;
}
function holes(target) {
	return target.apply(null, [1, , 3]);
}
check(
	holes(function (a, b, c) {
		return a === 1 && b === undefined && c === 3;
	}),
	"hole fallback",
);
function reused(target) {
	const values = [left, right];
	const result = target.apply(receiver, values);
	return result[2] === values[0] && target.apply(receiver, values)[3] === right;
}
check(reused(describe), "reused array fallback");
console.log("function-prototype-apply PASS");
const beforeThrow = [];
function failElement() {
	beforeThrow.push("element");
	throw sentinel;
}
try {
	describe.apply(receiver, [failElement(), right]);
	check(false, "element must throw");
} catch (error) {
	check(
		error === sentinel && beforeThrow.join() === "element",
		"element exception identity and ordering",
	);
}
function capture(value) {
	return function (a, b) {
		collect();
		return value + a + b;
	};
}
check(invoke(capture(10), null, 2, 3) === 15, "closure environment");
async function suspended(target) {
	const result = target.apply(receiver, [left, await Promise.resolve(right)]);
	check(
		result[0] === receiver && result[2] === left && result[3] === right,
		"suspended argument roots",
	);
}
suspended(describe).then(() => console.log("function-prototype-apply async PASS"));
