function format(value) {
	return String(+value);
}
function formatExtra(value, extra) {
	return String(+value, +extra);
}
function convert(value) {
	return String(value);
}
function caught(run) {
	try {
		return run();
	} catch (error) {
		return error.name;
	}
}
Object.assign(globalThis, { format, formatExtra, convert });
const output = [];
const mode = process.env.MAL_TEST_CASE ?? "values";
if (mode === "values") {
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
