function show(value) {
	console.log(Object.is(value, -0) ? "-0" : String(value));
}
let events = "";
show(Math.sumPrecise([1e20, 1, -1e20]));
show(Math.sumPrecise([]));
show(Math.sumPrecise([-0, -0]));
events = "";
const sumIterable = {
	[Symbol.iterator]() {
		events += "i";
		return {
			next() {
				events += "n";
				return { value: "1", done: false };
			},
			return() {
				events += "r";
				return {};
			},
		};
	},
};
try {
	Math.sumPrecise(sumIterable);
} catch (error) {
	show(error.name);
}
show(events);
function equal(actual, expected) {
	if (!Object.is(actual, expected))
		throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}
equal(
	Math.sumPrecise([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]),
	Number.MAX_VALUE,
);
equal(Math.sumPrecise([Number.MAX_VALUE, Number.MAX_VALUE]), Infinity);
equal(Math.sumPrecise([1, 2 ** -53, Number.MIN_VALUE]), 1 + Number.EPSILON);
equal(Math.sumPrecise([1, 2 ** -53, -Number.MIN_VALUE]), 1);
equal(Math.sumPrecise([-1, -(2 ** -53), -Number.MIN_VALUE]), -1 - Number.EPSILON);
equal(Math.sumPrecise([Infinity, -Infinity]), NaN);
equal(Math.sumPrecise([-0, 0]), 0);
function one(value) {
	return Math.sumPrecise([+value]);
}
function two(first, second) {
	return Math.sumPrecise([+first, +second]);
}
for (const value of [-0, 0, Number.MIN_VALUE, Infinity, -Infinity, NaN, 1e20]) {
	equal(one(value), value);
	for (const other of [-0, 0, Number.MIN_VALUE, Infinity, -Infinity, NaN, 1e20])
		equal(two(value, other), value + other);
}
events = "";
equal(
	two(
		{
			valueOf() {
				events += "a";
				return 2;
			},
		},
		{
			valueOf() {
				events += "b";
				return 3;
			},
		},
	),
	5,
);
equal(events, "ab");
events = "";
try {
	two(
		{
			valueOf() {
				events += "a";
				throw 7;
			},
		},
		{
			valueOf() {
				events += "b";
				return 3;
			},
		},
	);
} catch (error) {
	equal(error, 7);
}
equal(events, "a");
const mutated = [1, 2];
function mutate() {
	mutated[0] = 4;
}
mutate();
equal(Math.sumPrecise(mutated), 6);
const overridden = [1, 2];
overridden[Symbol.iterator] = function* () {
	yield 9;
};
equal(Math.sumPrecise(overridden), 9);
const accessor = [1, 2];
Object.defineProperty(accessor, "0", {
	get() {
		return 3;
	},
});
equal(Math.sumPrecise(accessor), 5);
for (const values of [
	[NaN, "2"],
	[1, , 2],
]) {
	let rejected = false;
	try {
		Math.sumPrecise(values);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	if (!rejected) throw new Error("Invalid sum element was ignored");
}
for (const [action, message] of [
	[() => Math.sumPrecise(1), "Value is not iterable"],
	[() => Math.sumPrecise(), "Cannot read properties of null or undefined"],
]) {
	let first;
	try {
		action();
	} catch (error) {
		first = error;
	}
	if (first?.name !== "TypeError" || first.message !== message)
		throw new Error("Sum input validation changed");
	try {
		action();
	} catch (error) {
		if (first === error) throw new Error("Sum error identity was reused");
	}
}
