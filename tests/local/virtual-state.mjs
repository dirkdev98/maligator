function privateArray(x) {
	const a = [1, 2];
	a.push(x);
	const last = a.pop();
	delete a[1];
	a.length = 1;
	return [last, a[0], a.length, 1 in a].join(":");
}
function escape(x, sink) {
	const a = [1, 2];
	a.push(x);
	a.pop();
	a[0] = x;
	sink(a);
	return a;
}
for (let i = 0; i < 3; i++) console.log(privateArray(i));
let observed;
const first = escape(42, (a) => {
	observed = a;
	a.push(9);
});
const second = escape(42, () => {});
console.log(first === observed, first !== second, first.join(":"), second.join(":"));

let calls = 0;
const key = {
	toString() {
		calls++;
		return "0";
	},
};
const from = {
	valueOf() {
		calls++;
		observed[0] = 11;
		return 0;
	},
};
const a = escape(8, (value) => {
	observed = value;
});
console.log(a[key], a.includes(11, from), calls, a[0]);

function readonly() {
	const value = [1, 2];
	Object.defineProperty(value, "1", { writable: false });
	try {
		value[0] = 9;
		value[1] = 7;
	} catch (error) {
		console.log(error instanceof TypeError, value.join(":"));
	} finally {
		console.log(value.length, value[0]);
	}
}
readonly();

function* suspended() {
	const value = [1];
	value.push(2);
	yield value;
	value.push(3);
	yield value;
}
const generator = suspended();
const yielded = generator.next().value;
yielded[0] = 4;
const resumed = generator.next().value;
console.log(yielded === resumed, resumed.join(":"), generator.next().done);

async function waiting() {
	const value = { x: 1 };
	value.x = 2;
	await 0;
	value.x++;
	return value;
}
console.log((await waiting()).x);

function recursive(n) {
	const value = [n];
	value.push(n + 1);
	if (n > 0) {
		const inner = recursive(n - 1);
		console.log(value !== inner, value.join(":"));
	}
	return value;
}
recursive(2);
function nonIndexProperty(value) {
	const array = [1, 2];
	array["4294967295"] = value;
	array["9007199254740992"] = value;
	array.length = 0;
	return [array.length, array["4294967295"], array["9007199254740992"]];
}
console.log(nonIndexProperty(42).join(":"));
const child = {};
const cycle = { child };
cycle.self = cycle;
const aliases = [cycle, cycle];
console.log(aliases[0] === aliases[1], cycle.self === cycle, cycle.child === child);
const weak = new WeakMap();
weak.set(cycle, 42);
console.log(weak.get(aliases[1]), new WeakRef(cycle).deref() === cycle);

function reversePrivate(value) {
	const array = [value, , undefined, 4];
	const before = array[0];
	const reversed = array.reverse();
	reversed.push(9);
	reversed.pop();
	return [before, reversed, array];
}
const reversedChild = {};
const reversedState = reversePrivate(reversedChild);
console.log(
	reversedState[0] === reversedChild,
	reversedState[1] === reversedState[2],
	reversedState[1][3] === reversedChild,
	reversedState[1].length,
	reversedState[1][0],
	Object.hasOwn(reversedState[1], 1),
	Object.hasOwn(reversedState[1], 2),
	Object.keys(reversedState[1]).join(":"),
);

function reverseEscape(sink) {
	const array = [1, 2, 3];
	const alias = array.reverse();
	sink(alias);
	return array;
}
let reverseAlias;
const reverseEscaped = reverseEscape((value) => {
	reverseAlias = value;
	value[1] = 8;
});
console.log(reverseEscaped === reverseAlias, reverseEscaped.join(":"));

function reverseReturned(value) {
	return [value, , 4].reverse();
}
const returnedReverse = reverseReturned(reversedChild);
console.log(
	returnedReverse[0],
	Object.hasOwn(returnedReverse, 1),
	returnedReverse[2] === reversedChild,
);

function reverseAfterEscape(sink) {
	const array = [1, 2];
	sink(array);
	return array.reverse();
}
console.log(reverseAfterEscape((value) => (value[0] = 7)).join(":"));
const extraReverse = [1, 2];
let reverseEffects = 0;
extraReverse.reverse((reverseEffects++, (extraReverse[0] = 7)));
console.log(reverseEffects, extraReverse.join(":"));

const inheritedReverse = [, 2];
const reversePrototype = Object.create(Array.prototype);
const inheritedReverseEvents = [];
Object.defineProperty(reversePrototype, "0", {
	get() {
		inheritedReverseEvents.push("get");
		return 8;
	},
	set(value) {
		inheritedReverseEvents.push(`set:${value}`);
	},
});
Object.setPrototypeOf(inheritedReverse, reversePrototype);
const inheritedReverseResult = Array.prototype.reverse.call(inheritedReverse);
console.log(
	inheritedReverseResult === inheritedReverse,
	Object.hasOwn(inheritedReverse, 0),
	inheritedReverse[1],
	inheritedReverseEvents.join(":"),
);

function reversePartialFailure() {
	const array = [1, 2, 3, 4];
	Object.defineProperty(array, "2", { writable: false });
	try {
		array.reverse();
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}
reversePartialFailure();
try {
	Object.freeze([1, 2]).reverse();
} catch (error) {
	console.log(error instanceof TypeError);
}

const reverseTarget = [1, 2];
const reverseProxyEvents = [];
const reverseProxy = new Proxy(reverseTarget, {
	has(target, key) {
		reverseProxyEvents.push(`has:${String(key)}`);
		return Reflect.has(target, key);
	},
	get(target, key, receiver) {
		reverseProxyEvents.push(`get:${String(key)}`);
		return Reflect.get(target, key, receiver);
	},
	set(target, key, value, receiver) {
		reverseProxyEvents.push(`set:${String(key)}:${value}`);
		return Reflect.set(target, key, value, receiver);
	},
});
console.log(
	Array.prototype.reverse.call(reverseProxy) === reverseProxy,
	reverseTarget.join(":"),
	reverseProxyEvents.join(","),
);

function reverseHandlerAlias() {
	const array = [1, 2];
	let alias;
	try {
		alias = array.reverse();
		throw 0;
	} catch {
		return [alias === array, array[0]].join(":");
	}
}
console.log(reverseHandlerAlias());

function fillAfterWrite() {
	const array = [2, 3];
	array[0] = 0;
	return array.fill(7, array[0]);
}
function fillAfterShift() {
	const array = [1, 2, 3];
	const start = array.shift();
	return array.fill(7, start);
}
function fillAfterReverse() {
	const array = [1, 0, 3];
	array.reverse();
	return array.fill(8, array[0]);
}
console.log(
	fillAfterWrite().join(":"),
	fillAfterShift().join(":"),
	fillAfterReverse().join(":"),
);

function shiftedPrivate(value) {
	const array = [value, , undefined, 4];
	const before = array[0];
	const shifted = array.shift();
	return [before === shifted, shifted, array];
}
const shiftedState = shiftedPrivate(reversedChild);
console.log(
	shiftedState[0],
	shiftedState[1] === reversedChild,
	shiftedState[2].length,
	Object.hasOwn(shiftedState[2], 0),
	Object.hasOwn(shiftedState[2], 1),
	shiftedState[2][1] === undefined,
	shiftedState[2][2],
);
const emptyShift = [];
emptyShift[-1] = 7;
console.log(emptyShift.shift(), emptyShift[-1], emptyShift.length);
const emptyPop = [];
emptyPop[-1] = 9;
console.log(emptyPop.pop(), emptyPop[-1], emptyPop.length);
const extraShift = [1, 2];
let shiftEffects = 0;
console.log(
	extraShift.shift((shiftEffects++, (extraShift[0] = 7))),
	shiftEffects,
	extraShift[0],
);

const inheritedShift = [1, , 3];
const shiftPrototype = Object.create(Array.prototype);
const inheritedShiftEvents = [];
Object.defineProperty(shiftPrototype, "1", {
	get() {
		inheritedShiftEvents.push("get");
		return 8;
	},
	set(value) {
		inheritedShiftEvents.push(`set:${value}`);
	},
});
Object.setPrototypeOf(inheritedShift, shiftPrototype);
console.log(
	Array.prototype.shift.call(inheritedShift),
	inheritedShift[0],
	Object.hasOwn(inheritedShift, 1),
	inheritedShift.length,
	inheritedShiftEvents.join(":"),
);
function shiftPartialFailure() {
	const array = [1, 2, 3];
	Object.defineProperty(array, "1", { writable: false });
	try {
		array.shift();
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}
shiftPartialFailure();

function unshiftedPrivate(value) {
	const array = [undefined, , 4];
	const before = array[2];
	const length = array.unshift(value, value);
	return [length, before, array];
}
const unshiftedState = unshiftedPrivate(reversedChild);
console.log(
	unshiftedState[0],
	unshiftedState[1],
	unshiftedState[2][0] === reversedChild,
	unshiftedState[2][0] === unshiftedState[2][1],
	Object.hasOwn(unshiftedState[2], 2),
	Object.hasOwn(unshiftedState[2], 3),
	unshiftedState[2][4],
);
const zeroUnshift = [, 2];
zeroUnshift[-1] = 7;
console.log(zeroUnshift.unshift(), Object.hasOwn(zeroUnshift, 0), zeroUnshift[-1]);
const inheritedUnshift = [, 2];
const unshiftPrototype = Object.create(Array.prototype);
const unshiftEvents = [];
Object.defineProperty(unshiftPrototype, "0", {
	get() {
		unshiftEvents.push("get");
		return 8;
	},
	set(value) {
		unshiftEvents.push(`set:${value}`);
	},
});
Object.setPrototypeOf(inheritedUnshift, unshiftPrototype);
console.log(
	Array.prototype.unshift.call(inheritedUnshift, 9),
	Object.hasOwn(inheritedUnshift, 0),
	inheritedUnshift[1],
	inheritedUnshift[2],
	unshiftEvents.join(":"),
);
function unshiftPartialFailure() {
	const array = [1, 2, 3];
	Object.defineProperty(array, "1", { writable: false });
	try {
		array.unshift(9);
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}
unshiftPartialFailure();
try {
	Object.freeze([1]).unshift();
} catch (error) {
	console.log(error instanceof TypeError);
}

function filledPrivate(value) {
	const array = [1, , 3];
	const before = array[2];
	const alias = array.fill(value, 1, undefined);
	return [before, alias === array, alias];
}
const filledState = filledPrivate(reversedChild);
console.log(
	filledState[0],
	filledState[1],
	filledState[2][1] === reversedChild,
	filledState[2][1] === filledState[2][2],
	Object.hasOwn(filledState[2], 1),
);
const defaultFill = [, 2];
defaultFill.fill();
console.log(
	defaultFill.length,
	Object.keys(defaultFill).join(":"),
	defaultFill[0],
	defaultFill[1],
);
const fillCoercionEvents = [];
const coercingFill = [1, 2, 3];
coercingFill.fill(
	9,
	{
		valueOf() {
			fillCoercionEvents.push("start");
			coercingFill[0] = 7;
			return 1;
		},
	},
	{
		valueOf() {
			fillCoercionEvents.push("end");
			return 2;
		},
	},
);
console.log(coercingFill.join(":"), fillCoercionEvents.join(":"));
for (const bound of [1n, Symbol("fill-bound")]) {
	const array = [1, 2];
	try {
		array.fill(9, bound);
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}
const inheritedFill = [1, , 3];
const fillPrototype = Object.create(Array.prototype);
const fillSetValues = [];
Object.defineProperty(fillPrototype, "1", {
	set(value) {
		fillSetValues.push(value);
	},
});
Object.setPrototypeOf(inheritedFill, fillPrototype);
console.log(
	Array.prototype.fill.call(inheritedFill, 8) === inheritedFill,
	inheritedFill[0],
	Object.hasOwn(inheritedFill, 1),
	inheritedFill[2],
	fillSetValues.join(":"),
);
function fillPartialFailure() {
	const array = [1, 2, 3];
	Object.defineProperty(array, "1", { writable: false });
	try {
		array.fill(9);
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}
fillPartialFailure();

const unshiftArgumentEvents = [];
function unshiftArgument(value) {
	unshiftArgumentEvents.push(value);
	return value;
}
const effectfulUnshift = [3];
effectfulUnshift.unshift(unshiftArgument(1), unshiftArgument(2));
console.log(effectfulUnshift.join(":"), unshiftArgumentEvents.join(":"));
const effectfulFill = [1, 2];
let ignoredFillEffects = 0;
effectfulFill.fill(9, 0, undefined, (ignoredFillEffects++, (effectfulFill[0] = 7)));
console.log(effectfulFill.join(":"), ignoredFillEffects);

for (const method of ["unshift", "fill"]) {
	const target = [1, 2];
	const events = [];
	const proxy = new Proxy(target, {
		has(target, key) {
			events.push(`has:${String(key)}`);
			return Reflect.has(target, key);
		},
		get(target, key, receiver) {
			events.push(`get:${String(key)}`);
			return Reflect.get(target, key, receiver);
		},
		set(target, key, value, receiver) {
			events.push(`set:${String(key)}:${value}`);
			return Reflect.set(target, key, value, receiver);
		},
	});
	const result = Array.prototype[method].call(proxy, 9);
	console.log(
		method,
		method === "fill" ? result === proxy : result,
		target.join(":"),
		events.join(","),
	);
}
function fillHandlerAlias() {
	const array = [1, 2];
	let alias;
	try {
		alias = array.fill(7);
		throw 0;
	} catch {
		return [alias === array, array[0], array[1]].join(":");
	}
}
console.log(fillHandlerAlias());

function copiedPrivate(value) {
	const array = [value, , undefined, 4];
	const before = array[0];
	const alias = array.copyWithin(1, 0, 3);
	return [before, alias, array];
}
const copiedState = copiedPrivate(reversedChild);
console.log(
	copiedState[0] === reversedChild,
	copiedState[1] === copiedState[2],
	copiedState[1][0] === copiedState[1][1],
	Object.hasOwn(copiedState[1], 2),
	Object.hasOwn(copiedState[1], 3),
	copiedState[1][3] === undefined,
	copiedState[1].length,
);
const forwardCopy = [1, , undefined, 4];
forwardCopy.copyWithin(0, 1, undefined);
console.log(
	Object.keys(forwardCopy).join(":"),
	forwardCopy[1],
	forwardCopy[2],
	forwardCopy[3],
);
const selfCopy = [1, , 3];
console.log(selfCopy.copyWithin() === selfCopy, Object.keys(selfCopy).join(":"));

const copyCoercionEvents = [];
const coercingCopy = [1, 2, 3, 4];
const copyBound = (label, result) => ({
	valueOf() {
		copyCoercionEvents.push(label);
		return result;
	},
});
coercingCopy.copyWithin(
	copyBound("target", 1),
	copyBound("start", 0),
	copyBound("end", 3),
);
console.log(coercingCopy.join(":"), copyCoercionEvents.join(":"));
copyCoercionEvents.length = 0;
coercingCopy.copyWithin(Infinity, copyBound("start", 0), copyBound("end", 3));
console.log(coercingCopy.join(":"), copyCoercionEvents.join(":"));
let copyExtraEffects = 0;
const extraCopy = [1, 2, 3];
extraCopy.copyWithin(1, 0, 2, (copyExtraEffects++, (extraCopy[0] = 7)));
console.log(extraCopy.join(":"), copyExtraEffects);
for (const bound of [1n, Symbol("copy-bound")]) {
	const array = [1, 2];
	try {
		array.copyWithin(bound, 0);
	} catch (error) {
		console.log(error instanceof TypeError, array.join(":"));
	}
}

const inheritedCopy = [1, , 3];
const copyPrototype = Object.create(Array.prototype);
const inheritedCopyEvents = [];
Object.defineProperty(copyPrototype, "1", {
	get() {
		inheritedCopyEvents.push("get");
		return 8;
	},
	set(value) {
		inheritedCopyEvents.push(`set:${value}`);
	},
});
Object.setPrototypeOf(inheritedCopy, copyPrototype);
console.log(
	Array.prototype.copyWithin.call(inheritedCopy, 1, 0, 2) === inheritedCopy,
	Object.hasOwn(inheritedCopy, 1),
	inheritedCopy[2],
	inheritedCopyEvents.join(":"),
);
function copyPartialFailure() {
	const array = [1, 2, , 4];
	Object.defineProperty(array, "1", { configurable: false });
	try {
		array.copyWithin(0, 1, 3);
	} catch (error) {
		console.log(
			error instanceof TypeError,
			array.join(":"),
			Object.keys(array).join(":"),
		);
	}
}
copyPartialFailure();
try {
	Object.freeze([1, 2]).copyWithin(0, 1);
} catch (error) {
	console.log(error instanceof TypeError);
}

const copyTarget = [1, , 3, 4];
const copyProxyEvents = [];
const copyProxy = new Proxy(copyTarget, {
	has(target, key) {
		copyProxyEvents.push(`has:${String(key)}`);
		return Reflect.has(target, key);
	},
	get(target, key, receiver) {
		copyProxyEvents.push(`get:${String(key)}`);
		return Reflect.get(target, key, receiver);
	},
	set(target, key, value, receiver) {
		copyProxyEvents.push(`set:${String(key)}:${value}`);
		return Reflect.set(target, key, value, receiver);
	},
	deleteProperty(target, key) {
		copyProxyEvents.push(`delete:${String(key)}`);
		return Reflect.deleteProperty(target, key);
	},
});
console.log(
	Array.prototype.copyWithin.call(copyProxy, 1, 0, 3) === copyProxy,
	copyTarget.join(":"),
	copyProxyEvents.join(","),
);

function disjointCopyOrder(length) {
	const order = [];
	const source = length - 4;
	const target = length - 2;
	const object = { length };
	for (let index = 0; index < 2; index++) {
		Object.defineProperty(object, String(source + index), {
			get() {
				order.push(`get:${index}`);
				return index + 7;
			},
		});
		Object.defineProperty(object, String(target + index), {
			set(value) {
				order.push(`set:${index}:${value}`);
			},
		});
	}
	Array.prototype.copyWithin.call(object, target, source, target);
	return order.join(":");
}
console.log(disjointCopyOrder(4), disjointCopyOrder(Number.MAX_SAFE_INTEGER));
function copyHandlerAlias() {
	const array = [1, 2, 3];
	let alias;
	try {
		alias = array.copyWithin(1, 0, 2);
		throw 0;
	} catch {
		return [alias === array, array[1], array[2]].join(":");
	}
}
console.log(copyHandlerAlias());
