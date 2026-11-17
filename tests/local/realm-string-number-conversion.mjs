function format(value) {
	return String(+value);
}
function formatExtra(value, extra) {
	return String(+value, +extra);
}
function convert(value) {
	return String(value);
}
function truth(value, prepare) {
	return Boolean(value, prepare());
}
function numberTruth(value, prepare) {
	return Number(!!value, prepare());
}
function stringTruth(value, prepare) {
	return String(!!value, prepare());
}
function numberUnknown(value, prepare) {
	return Number(value, prepare());
}
function stringUnknown(value, prepare) {
	return String(value, prepare());
}
function primitiveUnion(value) {
	return [Number(value ? null : undefined), String(value ? null : undefined)];
}
function stringIdentity(value) {
	return String(typeof value === "string" ? value : "");
}
function caught(run) {
	try {
		return run();
	} catch (error) {
		return error.name;
	}
}
Object.assign(globalThis, {
	format,
	formatExtra,
	convert,
	truth,
	numberTruth,
	stringTruth,
	numberUnknown,
	stringUnknown,
	primitiveUnion,
	stringIdentity,
});
const output = [];
const mode = process.env.MAL_TEST_CASE ?? "values";
if (mode === "primitive-matrix") {
	const prepare = () => 0;
	const hostile = {
		[Symbol.toPrimitive]() {
			throw new Error("unexpected coercion");
		},
	};
	for (const value of [
		undefined,
		null,
		false,
		true,
		0,
		-0,
		NaN,
		17,
		"",
		"text",
		0n,
		17n,
		Symbol("label"),
		hostile,
	])
		output.push([
			truth(value, prepare),
			numberTruth(value, prepare),
			stringTruth(value, prepare),
			primitiveUnion(value),
			stringIdentity(value),
		]);
	output.push([Boolean(), Number(), String()]);
} else if (mode === "primitive-selection") {
	for (const [name, call] of [
		["Boolean", truth],
		["Number", numberTruth],
		["String", stringTruth],
		["Number", numberUnknown],
		["String", stringUnknown],
	]) {
		const original = globalThis[name];
		try {
			output.push(
				call(true, () => {
					globalThis[name] = () => "replacement";
				}),
			);
			output.push(
				call(false, () => {
					globalThis[name] = original;
				}),
			);
			output.push(call(false, () => 0));
			output.push(
				caught(() =>
					call(true, () => {
						throw new RangeError();
					}),
				),
			);
		} finally {
			globalThis[name] = original;
		}
	}
} else if (mode === "values") {
	for (const value of [
		0,
		-0,
		42.5,
		-17,
		NaN,
		Infinity,
		-Infinity,
		1e-7,
		1e21,
		Number.MIN_VALUE,
		Number.MAX_VALUE,
		undefined,
	])
		output.push(format(value));
	output.push(
		caught(() => format(17n)),
		caught(() => format(Symbol("value"))),
	);
} else if (mode === "coercion") {
	const events = [];
	output.push(
		format({
			valueOf() {
				events.push("valueOf");
				return "42.5";
			},
			toString() {
				events.push("toString");
				return "unused";
			},
		}),
		caught(() =>
			format({
				valueOf() {
					throw new RangeError();
				},
			}),
		),
		events,
	);
} else if (mode === "mutation") {
	output.push(
		format({
			valueOf() {
				globalThis.String = () => "replaced";
				return 42.5;
			},
		}),
		String(42.5),
	);
} else if (mode === "restore") {
	const original = String;
	globalThis.String = () => "replaced";
	output.push(
		format({
			valueOf() {
				globalThis.String = original;
				return 42.5;
			},
		}),
		format(23),
	);
} else if (mode === "extras") {
	const events = [];
	const value = {
		valueOf() {
			events.push("value");
			return 42.5;
		},
	};
	output.push(
		caught(() =>
			formatExtra(value, {
				valueOf() {
					events.push("throw");
					throw new RangeError();
				},
			}),
		),
		formatExtra(value, {
			valueOf() {
				events.push("replace");
				globalThis.String = () => "replaced";
				return 7;
			},
		}),
		String(23),
		events,
	);
} else if (mode === "generic") {
	const events = [];
	output.push(
		convert({
			toString() {
				events.push("toString");
				return "object";
			},
			valueOf() {
				events.push("valueOf");
				return 7;
			},
		}),
		convert(Symbol("label")),
		convert(17n),
		caught(() =>
			convert({
				toString() {
					throw new TypeError();
				},
			}),
		),
		events,
	);
} else if (mode === "construction") {
	const first = new String(42.5),
		second = new String(42.5);
	class Derived extends String {}
	const derived = new Derived(17);
	function Alternate() {}
	const alternate = Reflect.construct(String, [23], Alternate);
	function shadow(String, value) {
		return String(+value);
	}
	output.push(
		first.valueOf(),
		first !== second,
		Object.getPrototypeOf(first) === String.prototype,
		derived.valueOf(),
		Object.getPrototypeOf(derived) === Derived.prototype,
		String.prototype.valueOf.call(alternate),
		Object.getPrototypeOf(alternate) === Alternate.prototype,
		caught(() => new String(Symbol("value"))),
		shadow(() => "local", 7),
	);
} else throw new Error("unknown String conversion case");
console.log(JSON.stringify(output));
