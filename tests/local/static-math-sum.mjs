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
	[() => Math.sumPrecise([1, "2"]), "Math.sumPrecise expects only Number values"],
	[() => Math.sumPrecise([NaN, "2"]), "Math.sumPrecise expects only Number values"],
	[
		() => Math.sumPrecise([Symbol.iterator]),
		"Math.sumPrecise expects only Number values",
	],
	[() => Math.sumPrecise([1n]), "Math.sumPrecise expects only Number values"],
	[() => Math.sumPrecise([1, , 2]), "Math.sumPrecise expects only Number values"],
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
events = "";
function invalidSum(produce) {
	return Math.sumPrecise([1, "x", produce()]);
}
try {
	invalidSum(() => {
		events += "v";
		return 3;
	});
} catch (error) {
	equal(error.message, "Math.sumPrecise expects only Number values");
}
equal(events, "v");
try {
	invalidSum(() => {
		throw 13;
	});
} catch (error) {
	equal(error, 13);
}

function three(first, second, third) {
	return Math.sumPrecise([+first, +second, +third]);
}
function generic(values) {
	return Math.sumPrecise({
		*[Symbol.iterator]() {
			for (const value of values) yield value;
		},
	});
}
for (const [values, expected] of [
	[[1e20, 1, -1e20], 1],
	[[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE], Number.MAX_VALUE],
	[[Number.MAX_VALUE, Number.MAX_VALUE, 0], Infinity],
	[[1, 2 ** -53, Number.MIN_VALUE], 1 + Number.EPSILON],
	[[1, 2 ** -53, -Number.MIN_VALUE], 1],
	[[-1, -(2 ** -53), -Number.MIN_VALUE], -1 - Number.EPSILON],
	[[Number.MIN_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE], Number.MIN_VALUE],
	[[-0, -0, -0], -0],
	[[-0, 0, -0], 0],
	[[Infinity, -Infinity, 1], NaN],
	[[NaN, 1, 2], NaN],
	[[Infinity, 1, 2], Infinity],
	[[-Infinity, 1, 2], -Infinity],
]) {
	equal(three(values[0], values[1], values[2]), expected);
	equal(generic(values), expected);
}
equal(generic([]), -0);
equal(generic([-0]), -0);
function sixtyFour(values) {
	return Math.sumPrecise([
		+values[0],
		+values[1],
		+values[2],
		+values[3],
		+values[4],
		+values[5],
		+values[6],
		+values[7],
		+values[8],
		+values[9],
		+values[10],
		+values[11],
		+values[12],
		+values[13],
		+values[14],
		+values[15],
		+values[16],
		+values[17],
		+values[18],
		+values[19],
		+values[20],
		+values[21],
		+values[22],
		+values[23],
		+values[24],
		+values[25],
		+values[26],
		+values[27],
		+values[28],
		+values[29],
		+values[30],
		+values[31],
		+values[32],
		+values[33],
		+values[34],
		+values[35],
		+values[36],
		+values[37],
		+values[38],
		+values[39],
		+values[40],
		+values[41],
		+values[42],
		+values[43],
		+values[44],
		+values[45],
		+values[46],
		+values[47],
		+values[48],
		+values[49],
		+values[50],
		+values[51],
		+values[52],
		+values[53],
		+values[54],
		+values[55],
		+values[56],
		+values[57],
		+values[58],
		+values[59],
		+values[60],
		+values[61],
		+values[62],
		+values[63],
	]);
}
const separated = [];
for (let index = 0; index < 32; index++) separated.push(2 ** (-1000 + index * 60));
for (let index = 31; index > 0; index--) separated.push(-separated[index]);
separated.push(-0);
equal(sixtyFour(separated), 2 ** -1000);
equal(generic(separated), 2 ** -1000);
for (const value of [-0, 0, 1, Number.MIN_VALUE, Infinity, -Infinity, NaN]) {
	equal(sixtyFour(Array(64).fill(value)), value * 64);
}
events = "";
equal(
	three(
		{
			valueOf() {
				events += "a";
				return 1e20;
			},
		},
		{
			valueOf() {
				events += "b";
				return 1;
			},
		},
		{
			valueOf() {
				events += "c";
				return -1e20;
			},
		},
	),
	1,
);
equal(events, "abc");
