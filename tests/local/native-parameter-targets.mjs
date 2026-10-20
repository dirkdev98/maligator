// A private function's parameters take the targets of every visible caller's
// arguments. Each case varies how a function value reaches a parameter, or
// lets a caller the analysis cannot see invoke the function.
const log = [];

function twice(f, x) {
	return f(f(x));
}
function increment(value) {
	return value + 1;
}
log.push(twice(increment, 1));

function search(values, key, select, compare) {
	let low = 0;
	let high = values.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const order = compare(select(values[middle]), key);
		if (order === 0) return middle;
		if (order < 0) low = middle + 1;
		else high = middle - 1;
	}
	return ~low;
}
const byId = (value) => value.id;
const byValue = (value) => value;
const numeric = (a, b) => a - b;
const ids = Array.from({ length: 50 }, (_, index) => ({ id: index * 3 }));
let found = 0;
for (let index = 0; index < 400; index++)
	if (search(ids, index, byId, numeric) >= 0) found++;
log.push(
	found,
	search([1, 4, 9], 9, byValue, numeric),
	search([1, 4, 9], 5, byValue, numeric),
);

// The callback escapes through an array, then a caller the analysis cannot name invokes the helper.
function relay(f, value) {
	return f(value) * 2;
}
const helpers = [relay];
log.push(
	helpers[0]((v) => v + 10, 1),
	relay(increment, 4),
);

// A constructor that returns a function hands it out without a tracked return.
function Factory() {
	return function produced(a, b) {
		return typeof b === "function" ? b(a) : a + b;
	};
}
const made = new Factory();
log.push(made(3, 4), made(3, increment));

function spread(f, ...rest) {
	return f(...rest);
}
function sum(...values) {
	return values.reduce((total, value) => total + value, 0);
}
log.push(spread(sum, 1, 2, 3), spread(Math.max, 4, 9, 2));

function applyAll(fns, value) {
	return fns.map((f) => f(value)).join(",");
}
log.push(applyAll([increment, byValue, (v) => v * v], 6));

function optional(f, value) {
	return typeof f === "function" ? f(value) : value;
}
log.push(optional(undefined, 5), optional(increment, 5));

// A helper repeating its callback gets a clone per distinct callback set; each
// clone is created by its call sites and binds the caller's scope chain.
let helperCalls = 0;
function each(values, f) {
	helperCalls++;
	let total = 0;
	for (const value of values) total += f(value);
	return total;
}
function relayEach(values, f) {
	return each(values, f) * 10;
}
function scoped(base) {
	const offset = (value) => value + base;
	function scaled(value) {
		return value * base;
	}
	function run(values) {
		return [each(values, offset), each(values, scaled), relayEach(values, offset)].join(
			"/",
		);
	}
	return run;
}
const runTwo = scoped(2);
const runThree = scoped(3);
log.push(runTwo([1, 2, 3]), runThree([1, 2, 3]), runTwo([]), helperCalls);

function failing(value) {
	if (value > 2) throw new TypeError(`too large: ${value}`);
	return value;
}
try {
	each([1, 2, 3], failing);
} catch (error) {
	log.push(`${error.name}: ${error.message}`);
}
log.push(each([1, 2], failing), helperCalls);

console.log(log.join("\n"));
