// Function declarations passed to Array iteration methods reach the call through
// their binding's module slot or captured cell rather than a local closure.
const values = [];
for (let index = 0; index < 40; index++) values.push(index);

console.log("hoisted", [1, 2, 3].map(early).join());
function early(value) {
	return value * 10;
}

function double(value) {
	return value * 2;
}
function isEven(value) {
	return value % 2 === 0;
}
function sum(total, value) {
	return total + value;
}
function withOffset(value) {
	return this.offset + value;
}
function fib(value) {
	return value < 2 ? value : fib(value - 1) + fib(value - 2);
}

function moduleCallbacks() {
	let total = 0;
	for (let round = 0; round < 20; round++) {
		total += values.map(double).filter(isEven).reduce(sum, 0);
		total += values.map(withOffset, { offset: round }).reduce(sum);
	}
	return [total, values.slice(0, 12).map(fib).join()];
}
console.log("module", JSON.stringify(moduleCallbacks()));

function shift(value) {
	return value + 1;
}
function invertShift() {
	shift = function (value) {
		return value - 1;
	};
}
function reassignedModule() {
	const results = [];
	for (let round = 0; round < 4; round++) {
		results.push(values.map(shift).reduce(sum, 0));
		if (round === 1) invertShift();
	}
	return results;
}
console.log("reassigned module", reassignedModule());

function captured(input) {
	function triple(value) {
		return value * 3;
	}
	const later = () => triple(1);
	let total = 0;
	for (let round = 0; round < 20; round++) total += input.map(triple).reduce(sum, 0);
	return [total, later()];
}
console.log("captured", captured(values));

function capturing(input, factor) {
	function scale(value) {
		return value * factor;
	}
	let total = 0;
	for (let round = 0; round < 6; round++) {
		total += input.map(scale).reduce(sum, 0);
		factor++;
	}
	return total;
}
console.log("capturing", capturing(values, 2));

function reassignedCaptured(input) {
	function pick(value) {
		return value;
	}
	const negate = () => {
		pick = (value) => -value;
	};
	const results = [];
	for (let round = 0; round < 4; round++) {
		results.push(input.map(pick).reduce(sum, 0));
		if (round === 1) negate();
	}
	return results;
}
console.log("reassigned captured", reassignedCaptured(values));

function activations(input) {
	const counters = [];
	for (let round = 0; round < 3; round++) {
		let seen = 0;
		function count(value) {
			seen++;
			return value + round;
		}
		counters.push(count);
		counters.push(input.map(count).reduce(sum, 0) + seen);
	}
	return counters.map((entry) => (typeof entry === "function" ? entry(0) : entry));
}
console.log("activations", activations(values));

try {
	values.map(thrower);
} catch (error) {
	console.log("thrown", error.message);
}
function thrower(value) {
	if (value === 7) throw new Error("stopped at " + value);
	return value;
}
