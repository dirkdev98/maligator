function check(actual, expected) {
	if (!Object.is(actual, expected)) throw new Error("forwarded call target mismatch");
}
const collect = globalThis.__mal_collect_garbage;
let visits = 0;
function visit() {
	visits++;
	if (typeof collect === "function") collect();
}
const make = function make(depth, offset, observe) {
	if (depth > 0) return make(depth - 1, offset, observe);
	for (let i = 0; i < 3; i++) observe();
	const state = { offset };
	return function produced(value) {
		for (let i = 0; i < 3; i++) observe();
		return state.offset + value;
	};
};
const forward = function forward(depth, offset, observe) {
	for (let i = 0; i < 3; i++) observe();
	return make(depth, offset, observe);
};
function invokeReturned(depth, offset, observe, value) {
	const callback = forward(depth, offset, observe);
	return typeof callback === "function" ? callback(value) : -1;
}
check(invokeReturned(2, 10, visit, 32), 42);
check(invokeReturned(0, 20, visit, 22), 42);
check(visits, 18);
let factoryArguments = 0;
function optionalFactory(flag) {
	const factory = flag ? forward : 17;
	return factory((factoryArguments++, 1), 40, visit);
}
check(optionalFactory(true)(2), 42);
try {
	optionalFactory(false);
	throw new Error("missing factory call error");
} catch (error) {
	check(error instanceof TypeError, true);
}
check(factoryArguments, 2);
const first = forward(2, 10, visit),
	second = forward(1, 20, visit);
check(first(1), 11);
check(second(2), 22);

function invokeSpread(args, value) {
	const callback = forward(...args);
	return typeof callback === "function" ? callback(value) : -1;
}
check(invokeSpread([1, 30, visit], 12), 42);
function* suspendedReturn(depth, offset, observe) {
	const callback = forward(depth, offset, observe);
	yield callback;
	return typeof callback === "function" ? callback(2) : -1;
}
const suspended = suspendedReturn(1, 40, visit);
check(suspended.next().value(1), 41);
if (typeof collect === "function") collect();
check(suspended.next().value, 42);

const scalar = function scalar(depth, observe, flag) {
	if (depth > 0) return scalar(depth - 1, observe, flag);
	for (let i = 0; i < 3; i++) observe();
	return flag ? Number.isFinite : 17;
};
const forwardScalar = function forwardScalar(depth, observe, flag) {
	for (let i = 0; i < 3; i++) observe();
	return scalar(depth, observe, flag);
};
check(typeof forwardScalar(2, visit, true), "function");
check(forwardScalar(2, visit, true)(42), true);
check(typeof forwardScalar(2, visit, false), "number");
let argumentsEvaluated = 0;
try {
	forwardScalar(1, visit, false)(argumentsEvaluated++);
	throw new Error("missing invalid invocation error");
} catch (error) {
	check(error instanceof TypeError, true);
}
check(argumentsEvaluated, 1);

const pass = function pass(factory) {
	for (let i = 0; i < 3; i++) visit();
	return factory();
};
const passAgain = function passAgain(factory) {
	for (let i = 0; i < 3; i++) visit();
	return pass(factory);
};
let traps = 0;
const callable = new Proxy(() => 11, {
	apply(target, receiver, args) {
		traps++;
		visit();
		return args[0] + 1;
	},
});
check(passAgain(() => callable)(41), 42);
check(traps, 1);
const revoked = Proxy.revocable(() => 11, {});
revoked.revoke();
check(typeof passAgain(() => revoked.proxy), "function");
try {
	passAgain(() => revoked.proxy)();
	throw new Error("missing revoked invocation error");
} catch (error) {
	check(error instanceof TypeError, true);
}
const marker = {};
try {
	passAgain(() => {
		throw marker;
	});
	throw new Error("missing factory exception");
} catch (error) {
	check(error, marker);
}
let reads = 0;
const holder = {
	get callback() {
		reads++;
		visit();
		return reads === 1 ? callable : 17;
	},
};
check(typeof passAgain(() => holder.callback), "function");
check(typeof passAgain(() => holder.callback), "number");
check(reads, 2);
const generator = function* generator() {
	return callable;
};
const iterator = passAgain(generator);
check(typeof iterator, "object");
check(iterator.next().value, callable);
const asyncFactory = async function asyncFactory() {
	return callable;
};
check(typeof passAgain(asyncFactory), "object");
const classFactory = function classFactory() {
	for (let i = 0; i < 3; i++) visit();
	return class ForwardedClass {};
};
const forwardClass = function forwardClass() {
	for (let i = 0; i < 3; i++) visit();
	return classFactory();
};
const Constructor = forwardClass();
check(typeof Constructor, "function");
check(new Constructor() instanceof Constructor, true);
try {
	Constructor();
	throw new Error("missing class invocation error");
} catch (error) {
	check(error instanceof TypeError, true);
}
Object.assign(globalThis, { invokeReturned, invokeSpread, suspendedReturn });
console.log("forwarded-call-targets PASS");
