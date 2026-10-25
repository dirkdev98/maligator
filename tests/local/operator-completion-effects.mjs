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
function primitiveRelation(left, right, operator) {
	const a = typeof left;
	const b = typeof right;
	switch (operator) {
		case "<":
			return a < b;
		case "<=":
			return a <= b;
		case ">":
			return a > b;
		case ">=":
			return a >= b;
		case "==":
			return a == b;
		case "!=":
			return a != b;
		case "===":
			return a === b;
		case "!==":
			return a !== b;
	}
}
function mixedRelation(left, right, flag, operator) {
	const a = flag ? String(left) : +left;
	const b = +right;
	switch (operator) {
		case "<":
			return a < b;
		case "<=":
			return a <= b;
		case ">":
			return a > b;
		case ">=":
			return a >= b;
		case "==":
			return a == b;
		case "!=":
			return a != b;
		case "===":
			return a === b;
		case "!==":
			return a !== b;
	}
}
function nullableObjectEqual(left, right, flag, observe) {
	const a = flag ? { value: left } : null;
	const b = flag ? a : { value: right };
	observe(a, b);
	return a == b;
}
function bigintStringEqual(left, right) {
	const a = BigInt(left);
	const b = String(right);
	return a == b;
}
function symbolLess(left, right) {
	const a = Symbol(left);
	const b = +right;
	return a < b;
}
function coerciveEqual(left, right) {
	return left == right;
}
function fusedRelation(left, right, flag) {
	const a = flag ? String(left) : +left;
	return a + 3 < +right;
}
Object.assign(globalThis, {
	negate,
	complement,
	primitiveCompare,
	primitiveComplement,
	compareText,
	primitiveRelation,
	mixedRelation,
	nullableObjectEqual,
	bigintStringEqual,
	symbolLess,
	coerciveEqual,
	fusedRelation,
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

for (const operator of ["<", "<=", ">", ">=", "==", "!=", "===", "!=="]) {
	for (const [left, right] of [
		[1, "7"],
		[null, undefined],
		[Symbol("left"), {}],
	])
		console.log("types", operator, primitiveRelation(left, right, operator));
	for (const flag of [false, true]) {
		for (const [left, right] of [
			["7", 7],
			["invalid", NaN],
			[-0, 0],
			["9007199254740993", 9007199254740992],
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
				"mixed",
				flag,
				operator,
				mixedRelation(box("left", left), box("right", right), flag, operator),
				events.join(","),
			);
		}
	}
}
for (const flag of [false, true]) {
	console.log(
		"fused",
		flag,
		fusedRelation(
			"7",
			{
				valueOf() {
					gc();
					return 74;
				},
			},
			flag,
		),
	);
	console.log(
		"objects",
		nullableObjectEqual({}, {}, flag, (a, b) => {
			for (const value of [a, b]) {
				if (value === null) continue;
				value[Symbol.toPrimitive] = () => {
					throw new Error("unexpected equality coercion");
				};
			}
			gc();
		}),
	);
}
for (const text of ["7", "invalid", "0007", "7".repeat(256).slice(250)])
	console.log("bigint", bigintStringEqual(7n, text));
try {
	symbolLess("description", {
		valueOf() {
			gc();
			return 1;
		},
	});
	throw new Error("missing Symbol comparison error");
} catch (error) {
	console.log("symbol", error instanceof TypeError);
}
for (const throws of [false, true]) {
	events.length = 0;
	try {
		console.log(
			"coercive",
			coerciveEqual(
				{
					[Symbol.toPrimitive](hint) {
						events.push(hint);
						gc();
						if (throws) throw { marker: "equality coercion" };
						return 7;
					},
				},
				7,
			),
			events.join(","),
		);
	} catch (error) {
		console.log("coercive throw", error.marker, events.join(","));
	}
}
