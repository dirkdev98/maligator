function floating(value) {
	return Number.parseFloat(value);
}
function integer(value, radix) {
	return Number.parseInt(value, radix);
}
function globalFloating(value) {
	return parseFloat(value);
}
function globalInteger(value, radix) {
	return parseInt(value, radix);
}
function floatingProperty(value) {
	return Number.parseFloat(value.text);
}
function integerProperty(value) {
	return Number.parseInt(value.text, value.radix);
}
function floatingExtra(value, prepare) {
	return Number.parseFloat(value, prepare());
}
function integerExtra(value, radix, prepare) {
	return Number.parseInt(value, radix, prepare());
}
function describe(value) {
	if (value !== value) return "NaN";
	if (Object.is(value, -0)) return "-0";
	if (value === Infinity) return "Infinity";
	if (value === -Infinity) return "-Infinity";
	return value;
}
function caught(run) {
	try {
		return describe(run());
	} catch (error) {
		return error.name;
	}
}
Object.assign(globalThis, { floating, integer, globalFloating, globalInteger });
const mode = process.env.MAL_TEST_CASE ?? "values";
const output = [];
if (mode === "values") {
	for (const text of [
		"42.5px",
		"-0tail",
		"0x2a",
		"Infinity",
		"NaN",
		"\u300042tail",
		"0." + "0".repeat(300) + "1tail",
	])
		output.push([describe(floating(text)), describe(globalFloating(text))]);
	for (const radix of [0, 10, 16, 2, 36, 4294967312, NaN, Infinity, -Infinity])
		output.push([
			describe(integer("0x2a", radix)),
			describe(globalInteger("0x2a", radix)),
		]);
	output.push(
		describe(Number.parseInt("0x2a")),
		describe(Number.parseInt("0x2a", undefined)),
		describe(Number.parseInt("0x2a", void 0)),
	);
	output.push(
		describe(Number.parseFloat()),
		describe(Number.parseInt()),
		describe(floating(new String("12.5tail"))),
		describe(integer("42tail", new Number(10))),
	);
} else if (mode === "coercion") {
	const events = [];
	output.push(
		integer(
			{
				toString() {
					events.push("text");
					return "2a";
				},
			},
			{
				valueOf() {
					events.push("radix");
					return 16;
				},
			},
		),
	);
	output.push(events, floating(17n), globalInteger(17n, 10));
} else if (mode === "mutation") {
	output.push(
		floatingProperty({
			get text() {
				Number.parseFloat = () => 61;
				return "12.5tail";
			},
		}),
	);
	output.push(Number.parseFloat("12.5tail"));
	output.push(
		integerProperty({
			text: "42tail",
			get radix() {
				Number.parseInt = () => 67;
				return 10;
			},
		}),
	);
	output.push(Number.parseInt("42tail", 10));
} else if (mode === "restore") {
	const float = Number.parseFloat,
		int = Number.parseInt;
	Number.parseFloat = () => 61;
	output.push(
		floatingProperty({
			get text() {
				Number.parseFloat = float;
				return "12.5tail";
			},
		}),
	);
	Number.parseInt = () => 67;
	output.push(
		integerProperty({
			text: "42tail",
			get radix() {
				Number.parseInt = int;
				return 10;
			},
		}),
	);
	output.push(Number.parseFloat("12.5tail"), Number.parseInt("42tail", 10));
} else if (mode === "extras") {
	output.push(
		floatingExtra("12.5tail", () => {
			Number.parseFloat = () => 61;
		}),
	);
	output.push(
		integerExtra("42tail", 10, () => {
			Number.parseInt = () => 67;
		}),
	);
	output.push(Number.parseFloat("12.5tail"), Number.parseInt("42tail", 10));
} else if (mode === "extra-throw") {
	const events = [];
	const value = {
		toString() {
			events.push("text");
			return "42";
		},
	};
	output.push(
		caught(() =>
			floatingExtra(value, () => {
				events.push("extra");
				throw new RangeError();
			}),
		),
	);
	output.push(events);
} else if (mode === "accessor") {
	const events = [];
	Object.defineProperty(Number, "parseFloat", {
		configurable: true,
		get() {
			events.push("method");
			return function () {
				return this === Number ? 61 : 0;
			};
		},
	});
	output.push(
		floatingProperty({
			get text() {
				events.push("argument");
				return "12.5tail";
			},
		}),
		events,
	);
} else if (mode === "symbols") {
	const events = [];
	output.push(
		caught(() => floating(Symbol())),
		caught(() => globalFloating(Symbol())),
	);
	output.push(
		caught(() => integer("42", Symbol())),
		caught(() => globalInteger("42", 10n)),
	);
	output.push(
		caught(() =>
			integer(Symbol(), {
				valueOf() {
					events.push("radix");
					return 10;
				},
			}),
		),
		events,
	);
} else if (mode === "shadow") {
	function shadow(Number, parseFloat, parseInt) {
		return [
			Number.parseFloat("text"),
			Number.parseInt("text", 10),
			parseFloat("text"),
			parseInt("text", 10),
		];
	}
	output.push(
		shadow(
			{
				parseFloat() {
					return "method float";
				},
				parseInt() {
					return "method int";
				},
			},
			() => "local float",
			() => "local int",
		),
	);
} else if (mode === "construct") {
	output.push(
		caught(() => new Number.parseFloat("1")),
		caught(() => new parseInt("1")),
	);
} else throw new Error("unknown parser case");
console.log(JSON.stringify(output));
