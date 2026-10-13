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
function exercise(index) {
	const object = { index },
		text = "retained-" + index;
	const values = literal(object, text, index);
	const produced = numeric(index, index + 0.5, object);
	if (typeof gc === "function") gc();
	return [
		values[0] === object,
		values[1] === text,
		values[2],
		build(index, index + 1, index + 2),
		produced.slice(0, 4),
		produced[4] === object,
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
}
console.log(JSON.stringify(rows));
