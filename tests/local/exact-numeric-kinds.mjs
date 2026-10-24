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

function rangedOperations(input, gate) {
	const unsigned = input >>> 0;
	const bounded = (unsigned & 65535) + 1;
	gate(bounded);
	return [
		Number.isSafeInteger(unsigned),
		Number.isInteger(unsigned * 2 + 1),
		Math.abs(unsigned),
		Math.sign(bounded),
		Math.min(bounded, 0),
		Math.max(bounded, 0),
		bounded ? 7 : 9,
		bounded < 0,
		bounded > 65536,
		bounded === 0,
		bounded ^ 7,
		unsigned ^ 7,
	];
}
function rangeControls(input) {
	const value = +input;
	const possibleNegativeZero = (input >>> 0) * -1;
	return [
		Math.abs(value),
		Math.sign(value),
		Math.min(value, 0),
		Math.max(value, 0),
		1 / Math.abs(possibleNegativeZero),
		1 / Math.sign(possibleNegativeZero),
		Number.isSafeInteger(value * 9007199254740991 + 1),
	];
}
function scopedRange(input, gate) {
	const value = input >>> 0;
	if (value < 16) {
		gate(value);
		return [Math.abs(value - 32), Math.sign(value - 32)];
	}
	return [Math.abs(value - 32), Math.sign(value - 32)];
}
function* suspendedRange(input) {
	const value = ((input >>> 0) & 65535) + 1;
	yield value;
	return [Number.isSafeInteger(value), Math.sign(value), value ? value ^ 7 : -1];
}
function rangedLoop(count) {
	let checksum = 0;
	for (let index = 0; index < count; index++) {
		const value = ((index >>> 0) & 255) + 1;
		checksum += value ? Math.min(value, 0) + Math.max(value, 0) : -999;
	}
	return checksum;
}
for (const edge of [...numericEdges, 15, 16, 31, 32]) {
	console.log("ranged", rangedOperations(edge, observe).map(show).join(" "));
	console.log("range controls", rangeControls(edge).map(show).join(" "));
	console.log("scoped range", scopedRange(edge, observe).map(show).join(" "));
	const iterator = suspendedRange(edge);
	console.log(
		"suspended range",
		show(iterator.next().value),
		iterator.next().value.map(show).join(" "),
	);
}
console.log("ranged loop", rangedLoop(1000), observations);

let scalarEffects = "";
function scalarArgument(tag, value) {
	scalarEffects += tag;
	return value;
}
const noncoercible = {
	[Symbol.toPrimitive]() {
		throw new Error("unexpected coercion");
	},
};
function scalarPredicates(value) {
	return [
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isNaN(value),
		Number.isSafeInteger(value),
		Object.is(value, value),
	];
}
function unusedScalarCalls(value) {
	Number.isFinite(scalarArgument("a", value), scalarArgument("b", noncoercible));
	Number.isInteger(scalarArgument("c", value));
	Number.isNaN(scalarArgument("d", value));
	Number.isSafeInteger(scalarArgument("e", value));
	Object.is(scalarArgument("f", value), scalarArgument("g", value));
}
for (const value of [
	noncoercible,
	Symbol("scalar"),
	7n,
	undefined,
	-0,
	NaN,
	Infinity,
	2.5,
]) {
	console.log("scalar predicates", scalarPredicates(value).join(" "));
	unusedScalarCalls(value);
}
console.log("unused scalar arguments", scalarEffects);
try {
	Number.isFinite(
		scalarArgument("h", noncoercible),
		(() => {
			scalarEffects += "i";
			throw new Error("scalar argument");
		})(),
	);
} catch (error) {
	console.log("scalar argument throw", error.message, scalarEffects);
}
try {
	new Number.isFinite(scalarArgument("j", 1));
} catch (error) {
	console.log("scalar construct", error instanceof TypeError, scalarEffects);
}
const scalarArgumentList = {
	get length() {
		scalarEffects += "k";
		return 1;
	},
	get 0() {
		scalarEffects += "l";
		return 7;
	},
};
console.log(
	"scalar apply",
	Number.isFinite.apply(null, scalarArgumentList),
	scalarEffects,
);
function scalarSpread(input) {
	Number.isSafeInteger(...input);
	return "expanded";
}
console.log(
	"scalar spread",
	scalarSpread({
		*[Symbol.iterator]() {
			scalarEffects += "m";
			yield noncoercible;
			scalarEffects += "n";
			yield 1;
		},
	}),
	scalarEffects,
);
function* scalarAcrossYield(value) {
	const hold = { value };
	const finite = Number.isFinite(value);
	yield hold;
	return [finite, hold.value === value];
}
const scalarIterator = scalarAcrossYield(noncoercible);
console.log("scalar suspended", scalarIterator.next().value.value === noncoercible);
console.log("scalar resumed", scalarIterator.next().value.join(" "));
