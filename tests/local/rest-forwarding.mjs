function check(condition, message) {
	if (!condition) throw new Error(message);
}
function sum(a = 0, b = 0, c = 0, d = 0) {
	return a + b + c + d;
}
function forward(...args) {
	return sum(...args);
}
function invoke(fn, ...args) {
	return fn(...args);
}
function nested(...args) {
	return forward(...args);
}
function applyForward(...args) {
	return sum.apply(this, args);
}
function dynamicApply(fn, receiver, ...args) {
	return fn.apply(receiver, args);
}
function repeated(...args) {
	let total = 0;
	for (let i = 0; i < 2; i++) total += sum(...args);
	return total;
}
function prefix(first, ...rest) {
	return sum(first, ...rest);
}
check(
	forward() === 0 && forward(3) === 3 && forward(1, 2, 3, 4) === 10,
	"argument counts",
);
const large = Array.from({ length: 128 }, (_, i) => i);
check(forward(...large) === 6, "large arguments");
check(nested(1, 2, 3, 4) === 10, "nested");
check(prefix(1, 2, 3, 4) === 10, "prefix");
check(applyForward(1, 2) === 3, "apply");
const receiver = { base: 20 };
function method(a, b) {
	return this.base + a + b;
}
check(dynamicApply(method, receiver, 1, 2) === 23, "apply this");
check(invoke(sum.bind(null, 10), 1, 2) === 13, "bound");
const proxy = new Proxy(sum, {
	apply(fn, receiver, args) {
		return Reflect.apply(fn, receiver, args) + 1;
	},
});
check(invoke(proxy, 1, 2) === 4, "proxy");
try {
	invoke(null, 1);
	throw new Error("missed noncallable");
} catch (e) {
	check(e instanceof TypeError, "noncallable");
}
function recurse(n, ...args) {
	return n === 0 ? invoke(sum, ...args) : recurse(n - 1, ...args);
}
check(recurse(8, 1, 2, 3) === 6, "recursion");
function mutate(...args) {
	args[0] = 40;
	return sum(...args);
}
check(mutate(1, 2) === 42, "mutation");
let escaped;
function escape(...args) {
	escaped = args;
	return sum(...args);
}
check(escape(2, 3) === 5 && Array.isArray(escaped) && escaped[0] === 2, "escape");
function identity(...args) {
	return args;
}
check(identity(1) !== identity(1), "array identity");
function captured(...args) {
	return () => sum(...args);
}
check(captured(1, 2)() === 3, "captured");
function churn() {
	for (let i = 0; i < 50; i++) {
		const x = { i, values: [i, i + 1] };
		if (x.values[0] !== i) throw new Error("churn");
	}
}
function reuse(first, ...rest) {
	first = { changed: true };
	churn();
	return invoke(...rest);
}
const object = { value: 19 };
function take(x) {
	churn();
	return x;
}
check(reuse("unused", take, object) === object, "snapshot and GC");
check(reuse(null, take, { value: 71 }).value === 71, "fresh argument GC");
function parameterReassign(fn, ...args) {
	fn = take;
	churn();
	return fn(...args);
}
check(parameterReassign(sum, object) === object, "parameter reassignment");
let trace = "";
const holder = {
	get fn() {
		trace += "get;";
		return method;
	},
};
function lookup(...args) {
	return holder.fn(...args);
}
holder.base = 30;
check(lookup(1, 2) === 33 && trace === "get;", "lookup and this");
const throwing = {
	get fn() {
		throw object;
	},
};
function throwLookup(...args) {
	return throwing.fn(...args);
}
try {
	throwLookup(1);
	throw new Error("missed getter throw");
} catch (e) {
	check(e === object, "getter throw");
}
function override(a, b) {
	return a + b;
}
override.apply = function (receiver, args) {
	check(this === override && Array.isArray(args), "override array");
	return receiver.base + args[0];
};
check(dynamicApply(override, receiver, 4) === 24, "overridden apply");
let applyReads = 0;
Object.defineProperty(override, "apply", {
	configurable: true,
	get() {
		applyReads++;
		return Function.prototype.apply;
	},
});
check(dynamicApply(override, null, 3, 4) === 7 && applyReads === 1, "apply accessor");
Object.defineProperty(override, "apply", {
	configurable: true,
	get() {
		throw object;
	},
});
try {
	dynamicApply(override, null, 3);
	throw new Error("missed apply throw");
} catch (e) {
	check(e === object, "apply getter throw");
}
function sideReceiver() {
	trace += "receiver;";
	return receiver;
}
function ordered(...args) {
	return override.apply(sideReceiver(), args);
}
Object.defineProperty(override, "apply", {
	configurable: true,
	get() {
		trace += "apply;";
		return Function.prototype.apply;
	},
});
trace = "";
check(ordered(3, 4) === 7 && trace === "apply;receiver;", "apply evaluation order");
const iterator = Array.prototype[Symbol.iterator];
const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const nextDescriptor = Object.getOwnPropertyDescriptor(iteratorPrototype, "next");
let steps = 0;
try {
	iteratorPrototype.next = function () {
		return steps++ === 0 ? { value: 77, done: false } : { done: true };
	};
	check(forward(1, 2) === 77 && steps === 2, "replaced iterator next");
	steps = 0;
	check(sum(...[1, 2]) === 77 && steps === 2, "ordinary spread next");
	steps = 0;
	check(Array.from([1, 2])[0] === 77 && steps === 2, "Array.from next");
	Object.defineProperty(iteratorPrototype, "next", {
		configurable: true,
		get() {
			steps++;
			return nextDescriptor.value;
		},
	});
	steps = 0;
	check(forward(2, 3) === 5 && steps === 1, "next accessor");
	Object.defineProperty(iteratorPrototype, "next", nextDescriptor);
	Array.prototype[Symbol.iterator] = function () {
		let once = false;
		return {
			next() {
				if (once) return { done: true };
				once = true;
				return { value: 91, done: false };
			},
		};
	};
	check(forward(2, 3) === 91, "replaced iterator");
	let previous;
	Array.prototype[Symbol.iterator] = function () {
		check(previous === undefined || previous === this, "repeated array identity");
		previous = this;
		let once = false;
		return {
			next() {
				if (once) return { done: true };
				once = true;
				return { value: 9, done: false };
			},
		};
	};
	check(repeated(2, 3) === 18, "loop fallback");
	let reads = 0;
	Object.defineProperty(Array.prototype, Symbol.iterator, {
		configurable: true,
		get() {
			reads++;
			return iterator;
		},
	});
	check(forward(2, 3) === 5 && reads === 1, "iterator accessor");
	Object.defineProperty(Array.prototype, Symbol.iterator, {
		configurable: true,
		get() {
			throw object;
		},
	});
	try {
		forward(1);
		throw new Error("missed iterator throw");
	} catch (e) {
		check(e === object, "iterator throw");
	}
} finally {
	Object.defineProperty(iteratorPrototype, "next", nextDescriptor);
	Object.defineProperty(Array.prototype, Symbol.iterator, {
		value: iterator,
		writable: true,
		configurable: true,
	});
}
function* generator(...args) {
	yield 1;
	return sum(...args);
}
const g = generator(2, 3);
check(g.next().value === 1 && g.next().value === 5, "generator suspension");
function argumentsForward() {
	return sum.apply(null, arguments);
}
check(argumentsForward(2, 3) === 5, "arguments object");
async function asyncForward(...args) {
	await 0;
	return sum(...args);
}
check((await asyncForward(2, 3)) === 5, "async suspension");
console.log("rest-forwarding PASS");
