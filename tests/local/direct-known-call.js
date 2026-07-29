const directTarget = function directTarget(value, expected) {
	"use strict";
	value += 0;
	value += 1;
	value += 2;
	value += 3;
	value += 4;
	value += 5;
	value += 6;
	value += 7;
	value += 8;
	value += 9;
	value += 10;
	value += 11;
	value += 12;
	value += 13;
	value += 14;
	value += 15;
	value += 16;
	value += 17;
	value += 18;
	value += 19;
	value += 20;
	value += 21;
	value += 22;
	value += 23;
	if (directTarget !== expected || this !== undefined) return -1;
	return value;
};

let checks = 0;
const ok = function (name, condition) {
	if (!condition) throw new Error("direct-known-call failure: " + name);
	checks++;
};

const order = [];
const mark = function (value) {
	order.push(value);
	return value;
};
ok("large target", directTarget(mark(1), (mark(2), directTarget)) === 277);
ok("argument order", order.join(",") === "1,2");

const makeAndInvoke = function (captured) {
	const closure = function closure(value, expected) {
		"use strict";
		value += 0;
		value += 1;
		value += 2;
		value += 3;
		value += 4;
		value += 5;
		value += 6;
		value += 7;
		value += 8;
		value += 9;
		value += 10;
		value += 11;
		value += 12;
		value += 13;
		value += 14;
		value += 15;
		value += 16;
		value += 17;
		value += 18;
		value += 19;
		value += 20;
		value += 21;
		value += 22;
		value += 23;
		return closure === expected && this === undefined ? captured + value : -1;
	};
	return closure(1, closure);
};
ok("first capture", makeAndInvoke(1000) === 1277);
ok("second capture", makeAndInvoke(2000) === 2277);

const identityTarget = function identityTarget(expected) {
	return this === undefined && identityTarget === expected;
};
ok("this/callee identity", identityTarget(identityTarget));

const overflow = function overflow(depth) {
	return overflow(depth + 1) + 1;
};
let overflowed = false;
try {
	overflow(0);
} catch (error) {
	overflowed = error instanceof RangeError;
}
ok("overflow", overflowed);

ok("check count", checks === 6);
console.log("direct-known-call PASS");
