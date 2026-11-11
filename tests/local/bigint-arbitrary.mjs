import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const values = [
	0n,
	1n,
	-1n,
	(1n << 63n) - 1n,
	1n << 127n,
	-(1n << 127n),
	(1n << 128n) + 17n,
	-(1n << 257n) + 3n,
	(1n << 1024n) - 1n,
	(1n << 4096n) + 123456789n,
];
const output = [
	[170141183460469231731687303715884105728n].join(),
	[340282366920938463463374607431768211457n, -(1n << 1024n) + 17n].join("|"),
];
const retained = [];
for (const value of values) {
	assert.equal(~value, -value - 1n);
	assert.equal(value ^ -1n, ~value);
	assert.equal(BigInt(value.toString()), value);
	for (const radix of [2, 3, 4, 8, 10, 16, 32, 36]) output.push(value.toString(radix));
	for (const bits of [0, 1, 63, 64, 127, 128, 129, 256, 1025])
		output.push(
			BigInt.asIntN(bits, value).toString(),
			BigInt.asUintN(bits, value).toString(),
		);
	for (const count of [0n, 1n, 31n, 32n, 63n, 64n, 127n, 128n, 129n, -1n, -128n])
		output.push((value << count).toString(), (value >> count).toString());
	for (const other of values) {
		output.push(
			(value + other).toString(),
			(value - other).toString(),
			(value * other).toString(),
		);
		output.push(
			value < other,
			value <= other,
			value > other,
			value >= other,
			value === other,
			value == other,
		);
		if (other !== 0n) {
			const quotient = value / other,
				remainder = value % other;
			assert.equal(quotient * other + remainder, value);
			assert.ok(remainder === 0n || remainder < 0n === value < 0n);
			output.push(quotient.toString(), remainder.toString());
		}
	}
	retained.push(value + 1n, { value: value * value });
	if (globalThis.gc) gc();
}
for (const text of [
	"",
	" ",
	"\uFEFF+123\u00a0",
	"-123",
	"0x100000000000000000000000000000001",
	"0o10000000000000000000000000000000000000000000000001",
	"0b10000000000000000000000000000000000000000000000000000000000000001",
])
	output.push(BigInt(text).toString());
for (const text of ["+0x1", "-0b1", "1_000", "1.5", "1e2", "0x", "+"])
	assert.throws(() => BigInt(text), SyntaxError);
for (const value of [0n, 1n, -1n, 9007199254740993n, (1n << 127n) + 1n, 1n << 1024n]) {
	for (const other of [
		0,
		-0,
		0.5,
		-0.5,
		Number.MAX_SAFE_INTEGER,
		9007199254740992,
		1e30,
		Number.MAX_VALUE,
		Infinity,
		-Infinity,
		NaN,
		"",
		"0",
		"1",
		"1.5",
		"9007199254740993",
		"not-a-number",
	])
		output.push(
			value == other,
			value < other,
			value <= other,
			value > other,
			value >= other,
		);
	output.push(Number(value));
}
for (const number of [0, -0, 9007199254740992, 1e30, 1e100, Number.MAX_VALUE])
	output.push(BigInt(number).toString());
for (const value of values) {
	const map = new Map([
		[value, "wide"],
		[value + (1n << 5000n), "different"],
	]);
	assert.equal(map.get(BigInt(value.toString())), "wide");
	assert.equal(new Set([value, BigInt(value.toString()), value + (1n << 5000n)]).size, 2);
	const object = { [value]: "property" };
	assert.equal(object[value.toString()], "property");
	const array = new BigInt64Array(1);
	array[0] = value;
	assert.equal(array[0], BigInt.asIntN(64, value));
	assert.equal(array.includes(value), value === array[0]);
	assert.equal(array.indexOf(value), value === array[0] ? 0 : -1);
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, value);
	assert.equal(view.getBigUint64(0), BigInt.asUintN(64, value));
	const atomic = new BigInt64Array(new SharedArrayBuffer(8));
	assert.equal(Atomics.store(atomic, 0, value), value);
	assert.equal(atomic[0], BigInt.asIntN(64, value));
	const previous = Atomics.compareExchange(
		atomic,
		0,
		{
			valueOf() {
				return BigInt(value.toString());
			},
		},
		{
			valueOf() {
				if (globalThis.gc) gc();
				return value + 1n;
			},
		},
	);
	assert.equal(previous, BigInt.asIntN(64, value));
	assert.equal(atomic[0], BigInt.asIntN(64, value + 1n));
	const buffer = Buffer.alloc(8);
	if (value < -(1n << 63n) || value >= 1n << 63n)
		assert.throws(() => buffer.writeBigInt64LE(value), RangeError);
	else {
		buffer.writeBigInt64LE(value);
		assert.equal(buffer.readBigInt64LE(), value);
	}
}
const clone = structuredClone({
	values,
	map: new Map(values.map((value) => [value, { value }])),
});
assert.deepEqual(clone.values, values);
for (const value of values) assert.equal(clone.map.get(value).value, value);
output.push(((-7n) ** 129n).toString(), (2n ** 257n).toString());
assert.equal(0n << (1n << 200n), 0n);
assert.equal(1n << -(1n << 200n), 0n);
assert.equal(-1n >> (1n << 200n), -1n);
assert.equal((-1n) ** (1n << 200n), 1n);
assert.throws(() => 2n ** -1n, RangeError);
assert.throws(() => 1n / 0n, RangeError);
assert.throws(() => 1n << (1n << 200n), RangeError);
assert.throws(() => 1n >>> 1n, TypeError);
// An uncaptured loop-carried value keeps exact BigInt operand kinds without being
// a constant, so operators take their typed paths.
function exactBigIntOperations() {
	let value = 3n;
	const results = [];
	for (let round = 0; round < 6; round++) {
		value = value * -7n + 5n;
		const zero = value - value;
		results.push(
			BigInt.asUintN(64, value * value * value).toString(),
			BigInt.asIntN(64, value ** 25n).toString(),
			Number(value & 65535n),
			(value >> 3n).toString(),
			(value % 5n).toString(),
			(value ^ (value << 70n)).toString(16),
		);
		try {
			results.push(String(value / zero));
		} catch (error) {
			results.push(error.name);
		}
		try {
			results.push(String(value >>> 1n));
		} catch (error) {
			results.push(error.name);
		}
		try {
			results.push(String(value << 1099511627776n));
		} catch (error) {
			results.push(error.name);
		}
	}
	return results;
}
output.push(exactBigIntOperations());
// Limb boundaries, Karatsuba-sized and unbalanced products, self-multiplication and
// division estimates against all-ones divisors.
const wideShapes = [];
for (const bits of [64n, 128n, 2047n, 2048n, 2049n, 4160n, 8256n]) {
	const ones = (1n << bits) - 1n;
	const mixed = ones / 3n + (1n << (bits - 1n));
	for (const [left, right] of [
		[ones, ones],
		[mixed, ones],
		[mixed, (mixed >> 700n) | 1n],
	]) {
		const product = left * right;
		const square = left * left;
		wideShapes.push(
			(product % 1000000007n).toString(),
			(square % 998244353n).toString(36),
			(product / right - left).toString(),
			((square + 12345n) % (right + 1n)).toString(16).slice(-24),
			(-product / (left | 1n)).toString(36).slice(0, 24),
		);
	}
}
output.push(wideShapes);
output.push(
	retained.map((value) =>
		typeof value === "bigint" ? value.toString() : value.value.toString(),
	),
);
console.log(JSON.stringify(output));

if (process.env.BIGINT_EVAL === "1") {
	const literal = "0x1" + "0".repeat(1024) + "7n";
	const read = eval("(() => { const saved = " + literal + "; return () => saved; })()");
	if (globalThis.gc) gc();
	assert.equal(read(), (1n << 4100n) + 7n);
	assert.equal(eval("-" + literal), -read());
	console.log("wide eval image PASS");
}
