const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function build(first, second, third) {
	const result = [];
	result.push(first);
	result.push(second);
	result.push(third);
	return result;
}
function literal(first, second, third) {
	return [first, second, third];
}
function numeric(first, second, reference) {
	first = +first;
	second = +second;
	return [first + 1, second * 2, first - second, first < second, reference];
}
function mixedLarge(first, second, reference) {
	first = +first;
	second = +second;
	return [
		reference,
		"tag",
		null,
		undefined,
		true,
		false,
		first + 1,
		second * 2,
		reference,
		"\ud800",
		null,
		undefined,
		true,
		false,
		first - second,
		first < second,
		reference,
		"𝌆",
		null,
		undefined,
		true,
		false,
		first * second,
		-0,
		reference,
		"",
		null,
		undefined,
		true,
		false,
		first / second,
		second - first,
	];
}
function exercise(index) {
	const object = { index },
		text = "retained-" + index;
	const values = literal(object, text, index);
	const produced = numeric(index, index + 0.5, object);
	const large = mixedLarge(index, index + 0.5, object);
	if (typeof gc === "function") gc();
	return [
		values[0] === object,
		values[1] === text,
		values[2],
		build(index, index + 1, index + 2),
		produced.slice(0, 4),
		produced[4] === object,
		large.length,
		[large[0], large[8], large[16], large[24]].every((value) => value === object),
		large.slice(1, 8),
		large[9].charCodeAt(0),
		large[17].length,
		Object.is(large[23], -0),
		large[30],
		large[31],
		Object.keys(large).length,
	];
}
const rows = Array.from({ length: 20 }, (_, i) => i).map(exercise);
rows.push(
	literal(-0, NaN, Infinity).map((value) =>
		Object.is(value, -0) ? "-0" : String(value),
	),
);
for (const [first, second] of [
	[-0, 0],
	[NaN, Infinity],
	[Infinity, -Infinity],
	[1e308, 1e308],
])
	rows.push(
		mixedLarge(first, second, null).map((value) =>
			Object.is(value, -0) ? "-0" : String(value),
		),
		numeric(first, second, null).map((value) =>
			Object.is(value, -0) ? "-0" : String(value),
		),
	);
const order = [];
function next(value) {
	order.push(value);
	return value;
}
rows.push([next(1), next(2), next(3)], order);
const coercions = [];
rows.push(
	numeric(
		{
			valueOf() {
				coercions.push("first");
				return 2;
			},
		},
		{
			valueOf() {
				coercions.push("second");
				return 3;
			},
		},
		"retained",
	),
	coercions,
);
function interruptedLiteral(first, observe) {
	return [first + 1, observe(), first * 2];
}
const interrupted = [];
try {
	interruptedLiteral(
		{
			valueOf() {
				interrupted.push("coerce");
				return 4;
			},
		},
		() => {
			interrupted.push("throw");
			throw new Error("stop");
		},
	);
} catch (error) {
	rows.push(error.message, interrupted);
}
function interruptedLarge(first, observe) {
	first = +first;
	return [
		first + 1,
		"tag",
		null,
		undefined,
		true,
		false,
		first * 2,
		"before",
		observe(),
		first + 3,
		"after",
		null,
		undefined,
		true,
		false,
		first - 1,
	];
}
const largeOrder = [];
try {
	interruptedLarge(
		{
			valueOf() {
				largeOrder.push("coerce");
				return 2;
			},
		},
		() => {
			largeOrder.push("throw");
			throw new Error("large-stop");
		},
	);
} catch (error) {
	rows.push(error.message, largeOrder);
}
const largeHole = [1, 2, 3, 4, 5, 6, 7, 8, , 10, 11, 12, 13, 14, 15, 16];
rows.push(largeHole.length, 8 in largeHole, Object.keys(largeHole).length);
const holes = [1, , 3];
rows.push(holes.length, 1 in holes);
if (typeof process !== "undefined" && process.env.MAL_ARRAY_MUTABLE === "mutable") {
	let writes = 0;
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		get() {
			return 77;
		},
		set() {
			writes++;
		},
	});
	const direct = literal(1, 2, 3),
		pushed = build(1, 2, 3);
	const inherited = pushed[1];
	delete Array.prototype[1];
	rows.push(direct, pushed, inherited, writes);
	let largeWrites = 0;
	Object.defineProperty(Array.prototype, "24", {
		configurable: true,
		get() {
			return "inherited";
		},
		set() {
			largeWrites++;
		},
	});
	const marker = { retained: true };
	const large = mixedLarge(2, 3, marker);
	if (typeof gc === "function") gc();
	const own = Object.getOwnPropertyDescriptor(large, "24");
	delete Array.prototype[24];
	rows.push(
		large.length,
		own.value === marker,
		own.enumerable,
		own.writable,
		own.configurable,
		largeWrites,
	);
}
console.log(JSON.stringify(rows));
