function round(x) {
	return Math.round(x);
}
function abs(x) {
	return Math.abs(x);
}
function sign(x) {
	return Math.sign(x);
}
function fround(x) {
	return Math.fround(x);
}
function log1p(x) {
	return Math.log1p(x);
}
function max(a, b) {
	return Math.max(a, b);
}
function min(a, b) {
	return Math.min(a, b);
}
const show = (value) => (Object.is(value, -0) ? "-0" : String(value));
const order = [];
const tracked = (name, value) => ({
	valueOf() {
		order.push(name);
		return value;
	},
});
const values = [
	0,
	-0,
	0.5,
	-0.5,
	1.5,
	-1.5,
	2.5,
	-2.5,
	2147483647,
	2147483648,
	-2147483649,
	4503599627370495.5,
	NaN,
	Infinity,
	-Infinity,
	1e-310,
	"2.5",
	null,
	undefined,
	true,
	tracked("value", -3.5),
];
for (const value of values) {
	console.log(
		[round, abs, sign, fround, log1p]
			.map((operation) => show(operation(value)))
			.join(" "),
		[max, min]
			.map((operation) => `${show(operation(value, -0))}/${show(operation(0, value))}`)
			.join(" "),
	);
}
order.length = 0;
console.log(show(max(tracked("left", 1), tracked("right", 2))), order.join(","));
for (const operation of [round, abs]) {
	try {
		operation(Symbol());
	} catch (error) {
		console.log(error.constructor.name);
	}
}
const originalRound = Math.round;
const originalMax = Math.max;
Math.round = (x) => x * 10;
Math.max = Math.min;
console.log(show(round(1.25)), show(max(1, 2)));
Math.round = Math.floor;
console.log(show(round(-1.5)), show(round("7.5")));
Math.round = originalRound;
Math.max = originalMax;
console.log(show(round(-1.5)), show(max(1, 2)));
let total = 0;
for (let index = 0; index < 1000; index++) total += round(index / 3) + max(index, 500.5);
console.log(total);
