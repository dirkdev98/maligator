const MOD = 1_000_000_007;
const show = (value) =>
	typeof value === "bigint" ? `${value}n` : Object.is(value, -0) ? "-0" : String(value);
function accumulate(source, count) {
	let checksum = 0;
	for (let index = 0; index < count; index++) checksum = (checksum + source(index)) % MOD;
	return checksum;
}
function negateSum(source, count) {
	let total = 0;
	for (let index = 0; index < count; index++) total = total - -source(index);
	return total;
}
function concatenate(left, right) {
	let text = left;
	for (let index = 0; index < 3; index++) text = text + right;
	return text;
}
const sources = {
	number: (index) => index * 3.5,
	string: (index) => `${index}`,
	numericObject: (index) => ({ valueOf: () => index * 2 }),
	stringObject: (index) => ({ toString: () => `${index}0`, valueOf: undefined }),
	negativeZero: () => -0,
	mixed: (index) =>
		index % 3 === 0 ? `${index}` : index % 3 === 1 ? index : { valueOf: () => -index },
};
for (const [name, source] of Object.entries(sources)) {
	console.log(name, show(accumulate(source, 2_000)), show(negateSum(source, 50)));
}
for (const value of [5n, { valueOf: () => 7n }, Symbol("s")]) {
	try {
		console.log("accumulate", show(accumulate(() => value, 3)));
	} catch (error) {
		console.log("accumulate", error.constructor.name);
	}
	try {
		console.log("negate", show(negateSum(() => value, 3)));
	} catch (error) {
		console.log("negate", error.constructor.name);
	}
}
console.log(
	show(concatenate(1n, "x")),
	show(concatenate("x", 2n)),
	show(concatenate(1n, 2n)),
);
console.log(show(concatenate(1, { toString: () => "!", valueOf: undefined })));
function bigintSum(count) {
	let total = 0n;
	for (let index = 0; index < count; index++) total = total - -BigInt(index);
	return total;
}
console.log(show(bigintSum(100)));
console.log(
	["4", "", " 2 ", true, null, undefined, { valueOf: () => "8" }, { valueOf: () => 3n }]
		.map((value) => show(-value))
		.join(" "),
);

function integerJoin(left, right, flag, gate, shift) {
	const value = flag ? left | 0 : right >> 1;
	gate(value);
	return [
		value & shift,
		value | shift,
		value ^ shift,
		value << shift,
		value >> shift,
		value >>> shift,
		~value,
		Number.isNaN(value),
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isSafeInteger(value),
	];
}
function numericJoin(left, right, flag) {
	const value = flag ? left | 0 : +right;
	return [value & 7, Number.isInteger(value), Number.isSafeInteger(value), 1 / value];
}
function* suspendedInteger(left, right, flag) {
	const value = flag ? left | 0 : right >> 1;
	yield value;
	return [value ^ 7, ~value, Number.isSafeInteger(value)];
}
const numericEdges = [
	-0,
	0.5,
	-2147483648,
	2147483647,
	2147483648,
	4294967295,
	9007199254740991,
	9007199254740992,
	NaN,
	Infinity,
	-Infinity,
	undefined,
	"-2147483649",
];
let observations = 0;
function observe(value) {
	observations++;
	globalThis.observedInteger = { value };
}
for (const edge of numericEdges) {
	for (const flag of [false, true]) {
		const shifts = {
			valueOf() {
				observations++;
				return 35;
			},
		};
		console.log(
			"integer join",
			integerJoin(edge, edge, flag, observe, shifts).map(show).join(" "),
		);
		console.log("numeric join", numericJoin(edge, edge, flag).map(show).join(" "));
		const iterator = suspendedInteger(edge, edge, flag);
		console.log(
			"suspended integer",
			show(iterator.next().value),
			iterator.next().value.map(show).join(" "),
		);
	}
}
for (const input of [
	3n,
	Symbol("integer"),
	{
		valueOf() {
			throw new Error("input");
		},
	},
]) {
	try {
		integerJoin(input, input, true, observe, 1);
	} catch (error) {
		console.log("integer input", error.constructor.name, observations);
	}
}
for (const shift of [
	3n,
	Symbol("shift"),
	{
		valueOf() {
			throw new Error("shift");
		},
	},
]) {
	try {
		integerJoin(17, 17, true, observe, shift);
	} catch (error) {
		console.log("integer shift", error.constructor.name, observations);
	}
}
try {
	integerJoin(
		17,
		17,
		true,
		() => {
			throw new Error("gate");
		},
		1,
	);
} catch (error) {
	console.log("integer gate", error.message, observations);
}
