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
function exercise(index) {
	const object = { index },
		text = "retained-" + index;
	const values = literal(object, text, index);
	if (typeof gc === "function") gc();
	return [
		values[0] === object,
		values[1] === text,
		values[2],
		build(index, index + 1, index + 2),
	];
}
const rows = Array.from({ length: 20 }, (_, i) => i).map(exercise);
rows.push(
	literal(-0, NaN, Infinity).map((value) =>
		Object.is(value, -0) ? "-0" : String(value),
	),
);
const order = [];
function next(value) {
	order.push(value);
	return value;
}
rows.push([next(1), next(2), next(3)], order);
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
