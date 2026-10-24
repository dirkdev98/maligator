const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof gc !== "function") throw new Error("operator-completion-effects requires GC");
const events = [];

function negate(input) {
	try {
		return -input;
	} catch (error) {
		gc();
		events.push("caught");
		throw error;
	}
}
function complement(input) {
	try {
		return ~input;
	} catch (error) {
		gc();
		events.push("caught");
		throw error;
	}
}
function primitiveCompare(input, flag, observe) {
	const value = flag ? !!input : null;
	observe(value);
	return value < undefined;
}
function primitiveComplement(input, flag, observe) {
	const value = flag ? !!input : null;
	observe(value);
	return ~value;
}
function compareText(left, right) {
	const a = "" + left;
	const b = "" + right;
	return a < b;
}
Object.assign(globalThis, {
	negate,
	complement,
	primitiveCompare,
	primitiveComplement,
	compareText,
});

function describe(value) {
	return Object.is(value, -0) ? "-0" : typeof value + ":" + String(value);
}
for (const name of ["negate", "complement"]) {
	for (const input of [0, -0, 1.5, NaN, Infinity, undefined, null, true, "23", 7n]) {
		events.length = 0;
		console.log(
			name,
			describe(input),
			describe(globalThis[name](input)),
			events.join(","),
		);
	}
	for (const mode of ["number", "bigint", "symbol", "throw"]) {
		events.length = 0;
		const input = {
			[Symbol.toPrimitive](hint) {
				events.push(hint);
				gc();
				if (mode === "throw") throw { marker: "coercion" };
				if (mode === "symbol") return Symbol("value");
				return mode === "bigint" ? 7n : 23;
			},
		};
		try {
			console.log(name, mode, describe(globalThis[name](input)), events.join(","));
		} catch (error) {
			gc();
			console.log(
				name,
				mode,
				error instanceof TypeError ? "TypeError" : error.marker,
				events.join(","),
			);
		}
	}
	events.length = 0;
	try {
		globalThis[name](Symbol("direct"));
		throw new Error("accepted a Symbol");
	} catch (error) {
		console.log(name, "direct-symbol", error instanceof TypeError, events.join(","));
	}
}

for (const flag of [false, true]) {
	for (const input of [null, false, 0, "text", { marker: "heap" }]) {
		const observe = (value) => {
			gc();
			events.push(describe(value));
		};
		events.length = 0;
		console.log(
			"primitive",
			flag,
			describe(input),
			primitiveCompare(input, flag, observe),
			primitiveComplement(input, flag, observe),
			events.join(","),
		);
	}
}

for (const [left, right] of [
	["", "a"],
	["a", "a"],
	["é", "ø"],
	["\ud800", "\ud801"],
	["\ud800\udfff", "\ue000"],
	["part".repeat(2048) + "a", "part".repeat(2048) + "b"],
]) {
	events.length = 0;
	const box = (label, value) => ({
		[Symbol.toPrimitive](hint) {
			events.push(label + ":" + hint);
			gc();
			return value;
		},
	});
	console.log(
		"text",
		compareText(box("left", left), box("right", right)),
		events.join(","),
	);
}
