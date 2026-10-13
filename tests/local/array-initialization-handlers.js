const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function afterHandler(reference, observe) {
	let caught;
	try {
		observe();
	} catch (error) {
		caught = error;
	}
	return [
		reference,
		caught,
		123456789012345678901234567890n,
		"tag",
		null,
		undefined,
		true,
		0n,
		reference,
	];
}
function catchValues(reference, observe) {
	try {
		observe();
	} catch (error) {
		return [
			reference,
			error,
			987654321098765432109876543210n,
			"caught",
			null,
			undefined,
			false,
			0n,
			reference,
		];
	}
	return null;
}
function protectedValues(reference, observe) {
	try {
		return [reference, observe(), 123n];
	} finally {
		observe("finally");
	}
}
function coercingValues(reference, observe) {
	try {
		return [reference + 1n, observe(), 123n];
	} catch (error) {
		return error.message;
	}
}
const rows = [];
const builders = new Array(2);
builders[0] = afterHandler;
builders[1] = catchValues;
for (let i = 0; i < 24; i++) {
	const reference = { index: i },
		thrown = { reason: "retained-" + i };
	const events = [];
	const observe = () => {
		events.push("observe");
		if (typeof gc === "function") gc();
		if ((i & 3) !== 0) throw thrown;
	};
	const builder = builders[i & 1];
	const result = builder(reference, observe);
	if (typeof gc === "function") gc();
	const descriptor = Object.getOwnPropertyDescriptor(result, "2");
	rows.push(
		result.length,
		result[0] === reference,
		result[1] === ((i & 3) === 0 ? undefined : thrown),
		result[8] === reference,
		String(result[2]),
		String(result[7]),
		result[3],
		result[4],
		String(result[5]),
		result[6],
		Object.keys(result).join(","),
		descriptor.enumerable,
		descriptor.writable,
		descriptor.configurable,
		events.join(","),
	);
}
const effects = [];
const object = {
	valueOf() {
		effects.push("coerce");
		return 3n;
	},
};
function fail(stage) {
	effects.push(stage === "finally" ? stage : "throw");
	if (stage !== "finally") throw new Error("stop");
}
rows.push(coercingValues(object, fail));
try {
	protectedValues(object, fail);
} catch (error) {
	rows.push(error.message);
}
rows.push(effects.join(","));
console.log(JSON.stringify(rows));
