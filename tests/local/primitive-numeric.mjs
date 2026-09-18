const results = [];

function record(value) {
	results.push(typeof value === "number" && Object.is(value, -0) ? "-0" : String(value));
}

function arithmetic(number, a, b, c) {
	let x = a ? number : b ? undefined : c ? null : true;
	const y = b ? number : c ? false : a ? undefined : null;
	record(x + y);
	record(x - y);
	record(x * y);
	record(x / y);
	record(x % y);
	record(x ** y);
	record(x & y);
	record(x | y);
	record(x ^ y);
	record(x << y);
	record(x >> y);
	record(x >>> y);
	record(x < y);
	record(x <= y);
	record(x > y);
	record(x >= y);
	record(x == y);
	record(x != y);
	record(x === y);
	record(x !== y);
	record(-x);
	record(+x);
	record(~x);
	record(x++);
	record(++x);
	record(x--);
	record(--x);
	record((-x + 2) * 3);
}

for (let i = 0; i < 8; i++) {
	for (const value of [-0, 0, -1.5, 4294967297, Infinity, -Infinity, NaN]) {
		arithmetic(value, !!(i & 1), !!(i & 2), !!(i & 4));
	}
}

function dynamicRemainder(left, right) {
	try {
		record(left % right);
	} catch (error) {
		record(error.name);
	}
}

for (const [left, right] of [
	[5, 7],
	[-5, 7],
	[5, -7],
	[-5, -7],
	[1.5, 2.25],
	[-1.5, 2.25],
	[-0, 7],
	[0, -7],
	[7, 7],
	[-7, 7],
	[14, 7],
	[-14, 7],
	[1, 0],
	[NaN, 3],
	[3, NaN],
	[Infinity, 3],
	[-Infinity, 3],
	[3, Infinity],
	[-3, -Infinity],
	[Number.MIN_VALUE, 1],
	[-Number.MIN_VALUE, 1],
	[Number.MAX_VALUE, Infinity],
	[Number.MAX_VALUE, 1e308],
]) {
	dynamicRemainder(left, right);
}

const remainderCoercions = [];
const remainderLeft = {
	valueOf() {
		remainderCoercions.push("left");
		return 5;
	},
};
const remainderRight = {
	valueOf() {
		remainderCoercions.push("right");
		return 7;
	},
};
dynamicRemainder(remainderLeft, remainderRight);
dynamicRemainder(5n, 2n);
dynamicRemainder(5n, 2);
dynamicRemainder(
	{
		valueOf() {
			remainderCoercions.push("throw-left");
			throw new Error("remainder coercion");
		},
	},
	{
		valueOf() {
			remainderCoercions.push("skipped-right");
			return 7;
		},
	},
);
record(remainderCoercions.join(","));

function general(x) {
	try {
		record(x + 2);
		record(-x);
		record(x ** 2);
	} catch (error) {
		record(error.name);
	}
}

let coercions = 0;
general("3");
general(Symbol("symbol"));
general(3n);
general({
	valueOf() {
		coercions++;
		return 3;
	},
});
general({
	valueOf() {
		coercions++;
		throw new Error("coercion");
	},
});
record(coercions);

let nullishFallbacks = 0;
function privateNumericNullish(index) {
	const values = [];
	values[0] = -0;
	values[2] = NaN;
	values[4] = Infinity;
	values[6] = -Infinity;
	return values[index] ?? (nullishFallbacks++, 7);
}

for (let index = 0; index <= 6; index++) record(privateNumericNullish(index));
record(nullishFallbacks);
console.log(JSON.stringify(results));
