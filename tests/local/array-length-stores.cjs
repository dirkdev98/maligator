"use strict";
// Stores of `length` on arrays, from stack truncation to frozen and sparse receivers.
function truncate(stack, length) {
	stack.length = length;
	return stack.length;
}
const results = [];
const stack = [];
for (let round = 0; round < 5000; round++) {
	const base = stack.length;
	stack.push(round, round * 2);
	if (round % 3 === 0) stack.push("extra");
	results.push(truncate(stack, base + (round % 2)));
}
results.push(stack.length, stack.join(",").length);

const grown = [1, 2];
grown.length = 5;
results.push(grown.length, 3 in grown, JSON.stringify(grown));

const frozen = Object.freeze([1, 2, 3]);
try {
	frozen.length = 1;
	results.push("frozen written");
} catch (error) {
	results.push(error.constructor.name, frozen.length);
}
(function sloppy() {
	const write = new Function("array", "array.length = 0; return array.length;");
	results.push(write(Object.freeze([4, 5])));
})();

const sealed = Object.seal([1, 2, 3]);
try {
	sealed.length = 1;
	results.push("sealed written");
} catch (error) {
	results.push(error.constructor.name, sealed.length);
}
sealed.length = 5;
results.push(sealed.length);

const pinned = [1, 2, 3, 4];
Object.defineProperty(pinned, 2, { value: 3, configurable: false });
try {
	pinned.length = 0;
	results.push("pinned written");
} catch (error) {
	results.push(error.constructor.name, pinned.length);
}

for (const bad of [-1, 1.5, 2 ** 32]) {
	try {
		[1, 2].length = bad;
		results.push("accepted", bad);
	} catch (error) {
		results.push(error.constructor.name);
	}
}

const sparse = [];
sparse[100] = 1;
sparse.length = 3;
results.push(sparse.length, 100 in sparse);

const saved = Array.prototype.length;
Array.prototype.length = 0;
results.push(Array.prototype.length, saved);
console.log(results.slice(0, 6).join(" "), results.slice(-24).join(" "));
