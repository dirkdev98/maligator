function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function exercise(dynamic) {
	assert("alpha,beta".split(",")[1] === "beta", "string receiver and argument");
	assert((17).valueOf() === 17, "number receiver");
	assert(true.valueOf() === true, "boolean receiver");
	assert(Object.is(undefined, dynamic), "mixed immediate and register arguments");
	assert(Object.is(null, null), "null arguments");
	assert(Object.is(false, false), "boolean arguments");

	let total = 0;
	for (let index = 0; index < 200; index++) {
		total += "a,b,c".split(",").length;
	}
	assert(total === 600, "allocating builtin under GC");

	let threw = false;
	try {
		Object.keys(null);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	assert(threw, "throwing builtin preserves completion");
}

exercise(globalThis.missing);
console.log("call-builtin-immediate-operands PASS");
