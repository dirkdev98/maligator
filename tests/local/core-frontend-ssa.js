function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function numericLoop(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) total += index;
	return total;
}

function denseFill(length) {
	const values = [];
	for (let index = 0; index < length; index++) values[index] = index * 2;
	let total = 0;
	for (let index = 0; index < values.length; index++) total += values[index];
	return total;
}

function exceptionLocal(value) {
	let errors = 0;
	try {
		value.x;
	} catch {
		errors += 1;
	}
	return errors + 1;
}

function mixedJoin(flag) {
	let value = 1;
	if (flag) value = "value";
	return value + 1;
}

function mixedLoop(flag) {
	let value = 0;
	while (value < 3) {
		if (flag && value === 1) {
			value = "2";
			flag = false;
		}
		value++;
	}
	return value;
}

function increment(value) {
	return ++value;
}

let effectGlobal = 1;
function conditionalGlobalStore(store, repeat) {
	let before;
	do {
		before = effectGlobal;
		if (store) effectGlobal = 7;
		const after = effectGlobal;
		if (repeat) {
			repeat = false;
			continue;
		}
		return after * 10 + before;
	} while (true);
}

let forwarded = 0;
function reassignForwarded() {
	forwarded = 99;
	return 1;
}
function storeThenCall() {
	forwarded = 5;
	const extra = reassignForwarded();
	return forwarded + extra;
}

let doubled = 0;
function storeThenRead(value) {
	doubled = value * 2;
	return doubled + 1;
}

let getterReads = 0;
const accessor = {
	get probe() {
		getterReads += 1;
		return getterReads;
	},
};
function readAccessorTwice() {
	return accessor.probe + accessor.probe;
}

function capturedAcrossCall() {
	let cell = 1;
	const bump = () => {
		cell += 10;
	};
	cell = 2;
	bump();
	return cell;
}

assert(numericLoop(1000) === 499500, "numeric induction variable");
assert(denseFill(100) === 9900, "dense indexed fill");
assert(exceptionLocal(null) === 2, "exception-edge local");
assert(exceptionLocal({ x: 1 }) === 1, "ordinary-edge local");
assert(mixedJoin(false) === 2, "number join");
assert(mixedJoin(true) === "value1", "boxed join");
assert(mixedLoop(true) === 3, "loop representation widening");
assert(increment(2) === 3, "number increment");
assert(increment(2n) === 3n, "bigint increment");
assert(
	conditionalGlobalStore(true, false) === 71,
	"conditional loop store reaches the following global load",
);
assert(storeThenRead(3) === 7, "store forwarded to the following global load");
assert(storeThenCall() === 100, "call between store and load reassigns the global");
assert(readAccessorTwice() === 3, "repeated accessor read runs the getter twice");
assert(getterReads === 2, "accessor reads are not shared");
assert(
	capturedAcrossCall() === 12,
	"call between store and load mutates the captured cell",
);

console.log("core-frontend-ssa PASS");
