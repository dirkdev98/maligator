function assert(condition, name) {
	if (!condition) throw new Error("fresh dense indexed reserve failure: " + name);
}

function fill() {
	const array = [];
	for (let index = 0; index < 16; index++) array[index] = index * 3;
	return array;
}

const first = fill();
const second = fill();
assert(first !== second, "identity");
assert(first.length === 16 && second.length === 16, "length");
for (let index = 0; index < 16; index++) {
	assert(first[index] === index * 3, "first value " + index);
	assert(second[index] === index * 3, "second value " + index);
}

let setterCalls = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	set(value) {
		setterCalls += value === 0 ? 1 : 100;
	},
});
const poisoned = fill();
assert(setterCalls === 1, "inherited setter");
assert(!Object.hasOwn(poisoned, "0"), "setter shadowing");
assert(poisoned.length === 16 && poisoned[15] === 45, "fallback fill");
delete Array.prototype[0];

console.log("fresh-dense-indexed-reserve PASS 20/20");
