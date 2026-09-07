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
console.log(JSON.stringify(results));
