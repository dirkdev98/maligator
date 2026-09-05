function check(condition, message) {
	if (!condition) throw new Error(message);
}
function target(a, b) {
	return a + b;
}
function forward(...args) {
	return target(...args);
}
function applyForward(fn, receiver, ...args) {
	return fn.apply(receiver, args);
}
const other = $262.createRealm().global;
const foreignIterator = other.Array.prototype[Symbol.iterator];
const foreignPrototype = other.Object.getPrototypeOf(
	new other.Array()[Symbol.iterator](),
);
const iterator = Array.prototype[Symbol.iterator];
let steps = 0;
foreignPrototype.next = function () {
	return steps++ === 0
		? { done: false, value: 31 }
		: steps === 2
			? { done: false, value: 11 }
			: { done: true };
};
try {
	Array.prototype[Symbol.iterator] = foreignIterator;
	check(forward(1, 2) === 42 && steps === 3, "foreign iterator protocol");
} finally {
	Array.prototype[Symbol.iterator] = iterator;
}
const invalid = { apply: other.Function.prototype.apply };
try {
	applyForward(invalid, null, 1, 2);
	throw new Error("missing apply exception");
} catch (e) {
	check(
		e instanceof other.TypeError && !(e instanceof TypeError),
		"foreign apply error realm",
	);
}
target.apply = other.Function.prototype.apply;
check(applyForward(target, null, 2, 3) === 5, "foreign apply callable");
console.log("rest-forwarding-realms PASS");
