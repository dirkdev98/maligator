function assert(value, message) {
	if (!value) throw new Error(message);
}
function ranges() {
	let total = 0;
	let index = 0;
	for (; index < 100; index++) total += ((index * 47) % 800) + (index % 9) + 1;
	assert(index === 100, "final update");
	assert(total === 41146, "bounded arithmetic");
	const inputs = [-8, -0, 0, 7, Infinity, NaN, Number.MAX_SAFE_INTEGER];
	for (const value of inputs) {
		const result = value % 4;
		if (value === -8 || Object.is(value, -0))
			assert(Object.is(result, -0), "negative remainder zero");
		assert(Number.isNaN(value % 0), "zero divisor");
	}
	assert(Number.MAX_SAFE_INTEGER + 1 === 9007199254740992, "overflow boundary");
}
function histogram() {
	const values = new Uint32Array(16);
	for (let index = 0; index < 100; index++) values[index & 15]++;
	let sum = 0;
	for (let index = 0; index < values.length; index++) sum += values[index];
	assert(sum === 100 && values[0] === 7, "masked histogram");
}
function dynamicLength(length) {
	const values = new Float64Array(length | 0);
	for (let index = 0; index < values.length; index++) values[index] = index + 0.5;
	let sum = 0;
	for (let index = 0; index < values.length; index++) sum += values[index];
	return sum;
}
function fallbacks() {
	const values = new Uint32Array(3);
	for (let index = 0; index < values.length; index++) {
		index += 1;
		values[index] = 9;
	}
	assert(values[1] === 9 && values[2] === 0, "modified induction");
	values[-1] = 3;
	values[0.5] = 4;
	assert(values[-1] === undefined && values[0.5] === undefined, "invalid indices");
	const buffer = new ArrayBuffer(16);
	const first = new Uint32Array(buffer);
	const alias = new Uint32Array(buffer);
	alias[0] = 123;
	assert(first[0] === 123, "external buffer alias");
	let coercions = 0;
	const key = {
		[Symbol.toPrimitive]() {
			coercions++;
			return 0;
		},
	};
	first[key] = first[0] + 1;
	assert(coercions === 1 && alias[0] === 124, "key coercion once");
	let threw = false;
	try {
		const absent = null;
		absent[15 & 3]++;
	} catch {
		threw = true;
	}
	assert(threw, "nil receiver");
}
ranges();
histogram();
assert(dynamicLength(0) === 0 && dynamicLength(4) === 8, "dynamic and empty extents");
fallbacks();
console.log("bounded-numeric-accesses PASS");
