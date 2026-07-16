function ok(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
}

var topBatchA, topBatchB, topBatchC;
for (const name of ["topBatchA", "topBatchB", "topBatchC"]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	ok(descriptor.value === undefined, name + " starts undefined");
	ok(descriptor.configurable === false, name + " is not configurable");
}

Object.defineProperty(globalThis, "preservedBatchVar", {
	value: 42,
	writable: true,
	enumerable: true,
	configurable: true,
});
(0, eval)("var evalBatchA, preservedBatchVar, evalBatchB;");
ok(preservedBatchVar === 42, "batch preserves an existing value");
for (const name of ["evalBatchA", "evalBatchB"]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	ok(descriptor.value === undefined, name + " starts undefined");
	ok(descriptor.configurable === true, name + " is configurable");
}

console.log("global-var-batch PASS");
