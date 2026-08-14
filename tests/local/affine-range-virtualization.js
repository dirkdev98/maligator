function assert(condition, name) {
	if (!condition) throw new Error("affine range virtualization failure: " + name);
}

function kernel() {
	let total = 0;
	for (let round = 0; round < 3; round++) {
		const range = [];
		for (let index = 0; index < 16; index++) range[index] = index;
		let sum = 0;
		for (let index = 0; index < 16; index++) sum += range[index];
		for (let index = 0; index < 16; index++) sum += range[(index * 3) % 16];
		total += sum;
	}
	return total;
}

assert(kernel() === 720, "virtual identity range");

// Poisoning indexed Array inheritance permanently drops the process-wide
// protector. The same compiled function must then execute its complete ordinary
// allocation/store/load path, including one inherited [[Set]] per fresh Array.
let setterCalls = 0;
let getterCalls = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		getterCalls++;
		return 0;
	},
	set(_value) {
		setterCalls++;
	},
});
assert(kernel() === 720, "poisoned prototype fallback result");
assert(setterCalls === 3, "poisoned prototype inherited setters");
assert(getterCalls === 6, "poisoned prototype inherited getters");
delete Array.prototype[0];

console.log("affine-range-virtualization PASS 4/4");
