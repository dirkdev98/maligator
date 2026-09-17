function check(condition, message) {
	if (!condition) throw new Error(message);
}

function checkThrows(callback, matches, message) {
	try {
		callback();
	} catch (error) {
		check(matches(error), message);
		return;
	}
	throw new Error(message);
}

function churn() {
	for (let index = 0; index < 100; index++) {
		const value = { index, values: [index, index + 1] };
		if (value.values[0] !== index) throw new Error("churn");
	}
}

function read(index, ...values) {
	const key = +index;
	churn();
	return values[key];
}

const object = { value: 17 };
const symbol = Symbol("payload");
check(read(0, object) === object, "object identity");
check(read(-0, object) === object, "negative zero");
check(read(1, "first", undefined) === undefined, "explicit undefined");
check(read(2, 1, 2, 3n) === 3n, "bigint payload");
check(read(3, 1, 2, 3, symbol) === symbol, "symbol payload");
check(read(0) === undefined, "empty rest");
check(read(-1, object) === undefined, "negative index");
check(read(0.5, object) === undefined, "fractional index");
check(read(NaN, object) === undefined, "NaN index");
check(read(Infinity, object) === undefined, "infinite index");
check(read(8, object) === undefined, "out of bounds");
checkThrows(
	() => read(1n, object),
	(error) => error instanceof TypeError,
	"bigint key",
);
checkThrows(
	() => read(Symbol("key"), object),
	(error) => error instanceof TypeError,
	"symbol key",
);

const marker = {};
let coercions = 0;
const throwingKey = {
	[Symbol.toPrimitive]() {
		coercions++;
		throw marker;
	},
};
checkThrows(
	() => read(throwingKey, object),
	(error) => error === marker,
	"throwing key",
);
check(coercions === 1, "single key coercion");

console.log("rest-packed-reads PASS");
