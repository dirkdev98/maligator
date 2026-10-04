"use strict";

const results = [];
function check(name, condition) {
	results.push([name, condition]);
}

function expectTypeError(operation) {
	try {
		operation();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

check(
	"dense deque round trips",
	(() => {
		const values = Array.from({ length: 16 }, (_, index) => index);
		let checksum = 0;
		for (let round = 0; round < 4096; round++) {
			values.push(round & 255, (round + 1) & 255);
			const popped = values.pop();
			const shifted = values.shift();
			const length = values.unshift((round * 3) & 255);
			const restored = values.pop();
			if (length !== 17 || values.length !== 16) return false;
			checksum += popped + shifted + restored + values[0];
		}
		return checksum === 2088707 && values.length === 16;
	})(),
);

check(
	"empty pop and shift return undefined",
	(() => {
		const empty = [];
		for (let round = 0; round < 3; round++) {
			if (empty.pop() !== undefined || empty.shift() !== undefined) return false;
		}
		return empty.length === 0;
	})(),
);

check(
	"unshift with several arguments keeps their order",
	(() => {
		const values = [5];
		for (let round = 0; round < 2; round++) values.unshift(1, 2, 3, 4, 5, 6);
		return values.join(",") === "1,2,3,4,5,6,1,2,3,4,5,6,5";
	})(),
);

check(
	"holes read through the prototype chain",
	(() => {
		Array.prototype[0] = "inherited";
		const sparse = [, "b"];
		const shifted = sparse.shift();
		const tail = [, ,];
		const popped = tail.pop();
		delete Array.prototype[0];
		return shifted === "inherited" && sparse.length === 1 && popped === undefined;
	})(),
);

check(
	"frozen and fixed-length Arrays reject mutation",
	(() => {
		const frozen = Object.freeze([1, 2]);
		const fixed = [1, 2];
		Object.defineProperty(fixed, "length", { writable: false });
		return (
			expectTypeError(() => frozen.pop()) &&
			expectTypeError(() => frozen.shift()) &&
			expectTypeError(() => frozen.unshift(0)) &&
			expectTypeError(() => fixed.pop()) &&
			expectTypeError(() => fixed.unshift(0)) &&
			frozen.length === 2 &&
			fixed.length === 2
		);
	})(),
);

check(
	"subclasses and own overrides keep their methods",
	(() => {
		class Tracked extends Array {
			pop() {
				return "tracked";
			}
		}
		const tracked = Tracked.from([1, 2]);
		const own = [1, 2];
		own.shift = () => "own";
		let matches = 0;
		for (let round = 0; round < 3; round++) {
			if (tracked.pop() === "tracked") matches++;
			if (own.shift() === "own") matches++;
		}
		return matches === 6 && tracked.length === 2 && own.length === 2;
	})(),
);

check(
	"array-likes use the generic algorithm",
	(() => {
		const like = { length: 2, 0: "a", 1: "b" };
		const popped = Array.prototype.pop.call(like);
		const shifted = Array.prototype.shift.call(like);
		const length = Array.prototype.unshift.call(like, "z");
		return popped === "b" && shifted === "a" && length === 1 && like[0] === "z";
	})(),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
