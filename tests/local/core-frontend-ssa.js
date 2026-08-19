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

assert(numericLoop(1000) === 499500, "numeric induction variable");
assert(denseFill(100) === 9900, "dense indexed fill");
assert(exceptionLocal(null) === 2, "exception-edge local");
assert(exceptionLocal({ x: 1 }) === 1, "ordinary-edge local");
assert(mixedJoin(false) === 2, "number join");
assert(mixedJoin(true) === "value1", "boxed join");
assert(mixedLoop(true) === 3, "loop representation widening");
assert(increment(2) === 3, "number increment");
assert(increment(2n) === 3n, "bigint increment");

console.log("core-frontend-ssa PASS");
