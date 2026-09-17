function check(condition, message) {
	if (!condition) throw new Error(message);
}

function collect(first, second, ...rest) {
	return rest;
}

check(collect().length === 0, "missing fixed arguments");
check(collect(1).length === 0, "partially supplied fixed arguments");
check(collect(1, 2).length === 0, "no rest arguments");
check(collect(1, 2) !== collect(1, 2), "fresh empty arrays");
const reference = { value: 71 };
const values = collect(1, 2, undefined, reference, "text", null, 5);
check(values.length === 5, "rest length");
check(Object.hasOwn(values, 0) && values[0] === undefined, "explicit undefined");
check(values[1] === reference && values[2] === "text" && values[3] === null, "values");
check(Object.getPrototypeOf(values) === Array.prototype, "intrinsic prototype");
const descriptor = Object.getOwnPropertyDescriptor(values, "1");
check(
	descriptor.value === reference &&
		descriptor.writable &&
		descriptor.enumerable &&
		descriptor.configurable,
	"default element attributes",
);
values[1] = 19;
check(reference.value === 71 && values[1] === 19, "independent element storage");
delete values[2];
check(!Object.hasOwn(values, 2) && values.length === 5, "deletion");
values.length = 1;
check(!Object.hasOwn(values, 4), "length truncation");

const input = Array.from({ length: 129 }, (_, index) => ({ index }));
const many = collect("first", "second", ...input);
for (let index = 0; index < input.length; index++) {
	check(many[index] === input[index], "large reference array");
}

function collectOwnedReferences() {
	const local = Array.from({ length: 129 }, (_, index) => ({ index }));
	return collect("first", "second", ...local);
}

const owned = collectOwnedReferences();
let churnChecksum = 0;
for (let round = 0; round < 64; round++) {
	const garbage = Array.from({ length: 64 }, (_, index) => ({ index, round }));
	churnChecksum += garbage[round & 63].index;
}
check(churnChecksum === 2016, "allocation churn");
for (let index = 0; index < owned.length; index++) {
	check(owned[index].index === index, "rest array retains sole-owned references");
}

let prototypeCalls = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		prototypeCalls++;
		return "inherited";
	},
	set() {
		prototypeCalls++;
	},
});
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	writable: false,
	value: "read-only",
});
let inherited;
try {
	inherited = collect(1, 2, reference, undefined, 23);
} finally {
	delete Array.prototype[0];
	delete Array.prototype[1];
}
check(prototypeCalls === 0, "rest creation must not invoke prototype accessors");
check(Object.hasOwn(inherited, 0) && inherited[0] === reference, "own accessor shadow");
check(Object.hasOwn(inherited, 1) && inherited[1] === undefined, "own read-only shadow");
check(inherited.length === 3 && inherited[2] === 23, "prototype-independent length");
console.log("rest-materialization PASS");
