function convert(value) {
	return Number(value);
}
function property(value) {
	return Number(value.text);
}
function span(value) {
	return Number(value.slice(1, -1));
}
function extra(value, prepare) {
	return Number(value, prepare());
}
function splitProjection(value) {
	const part = value.split("|")[1];
	return part.length + Number(part);
}
function captureProjection(value) {
	const match = /\|([^|]*)\|/.exec(value);
	if (match === null) return -1;
	const part = match[1];
	return part.length + Number(part);
}
function projectedExtra(value, prepare) {
	const part = value.slice(1, -1);
	return part.length + Number(part, prepare());
}
function stringSpanProjection(value, prepare) {
	const part = value.slice(1, -1);
	const converted = String(part, prepare());
	return [part.length, converted];
}
function stringSplitProjection(value, prepare) {
	const part = value.split("|")[1];
	const converted = String(part, prepare());
	return [part.length, converted];
}
function stringCaptureProjection(value, prepare) {
	const part = /\|([^|]*)\|/.exec(value)[1];
	const converted = String(part, prepare());
	return [part.length, converted];
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
Object.assign(globalThis, {
	convert,
	property,
	span,
	extra,
	splitProjection,
	captureProjection,
	projectedExtra,
	stringSpanProjection,
	stringSplitProjection,
	stringCaptureProjection,
});
const output = [];
const mode = process.env.MAL_TEST_CASE ?? "values";
if (mode === "string-projections") {
	for (let source = 0; source < 3; source++) {
		const project = [
			stringSpanProjection,
			stringSplitProjection,
			stringCaptureProjection,
		][source];
		const text = source === 0 ? "[17]" : "a|17|b";
		output.push(project(text, () => 0));
		const original = String;
		try {
			output.push(
				project(text, () => {
					globalThis.String = () => "replacement";
				}),
			);
			output.push(
				project(text, () => {
					globalThis.String = original;
				}),
			);
			output.push(
				caught(() =>
					project(text, () => {
						throw new RangeError();
					}),
				),
			);
		} finally {
			globalThis.String = original;
		}
	}
} else if (mode === "values") {
	for (const text of [
		"",
		" \u3000",
		"42.5",
		"-0",
		"0x2a",
		"0b101",
		"0o17",
		"-0x2a",
		"Infinity",
		"-Infinity",
		"1e309",
		"NaN",
		"42tail",
		"1_000",
		"17n",
		"9007199254740993",
		"\u300017\u00a0",
		"0." + "0".repeat(300) + "1",
	])
		output.push(describe(convert(text)), describe(span("[" + text + "]")));
	output.push(
		describe(Number()),
		describe(convert(undefined)),
		describe(convert(17n)),
		describe(convert(true)),
		describe(convert(false)),
	);
} else if (mode === "coercion") {
	const events = [];
	output.push(
		convert({
			valueOf() {
				events.push("valueOf");
				return {};
			},
			toString() {
				events.push("toString");
				return "42.5";
			},
		}),
	);
	output.push(
		convert({
			valueOf() {
				return 17n;
			},
		}),
		convert(new String("12.5")),
	);
	output.push(
		Number.isFinite(
			Number({
				valueOf() {
					Number.isFinite = () => false;
					return 7;
				},
			}),
		),
		Number.isFinite(7),
	);
	output.push(
		caught(() => convert(Symbol())),
		caught(() =>
			convert({
				valueOf() {
					throw new RangeError();
				},
			}),
		),
		events,
	);
} else if (mode === "mutation") {
	output.push(
		property({
			get text() {
				globalThis.Number = () => 61;
				return "42.5";
			},
		}),
	);
	output.push(Number("42.5"));
} else if (mode === "restore") {
	const original = Number;
	globalThis.Number = () => 61;
	output.push(
		property({
			get text() {
				globalThis.Number = original;
				return "42.5";
			},
		}),
	);
	output.push(Number("42.5"));
} else if (mode === "slice-mutation") {
	output.push(
		span({
			slice() {
				globalThis.Number = () => 67;
				return "42.5";
			},
		}),
	);
	output.push(Number("42.5"));
} else if (mode === "extras") {
	const events = [];
	output.push(
		caught(() =>
			extra(
				{
					valueOf() {
						events.push("value");
						return 7;
					},
				},
				() => {
					events.push("extra");
					throw new RangeError();
				},
			),
		),
	);
	output.push(
		extra("42.5", () => {
			events.push("replace");
			globalThis.Number = () => 61;
		}),
	);
	output.push(Number("42.5"), events);
} else if (mode === "projections") {
	output.push(splitProjection("a|17|b"), captureProjection("a|42|b"));
	output.push(
		caught(() => splitProjection("missing")),
		captureProjection("missing"),
	);
	output.push(projectedExtra("[23]", () => {}));
	output.push(
		projectedExtra("[23]", () => {
			globalThis.Number = () => 71;
		}),
	);
	output.push(splitProjection("a|17|b"));
} else if (mode === "construction") {
	const first = new Number("42.5"),
		second = new Number("42.5");
	class Derived extends Number {}
	const derived = new Derived("17");
	output.push(
		first.valueOf(),
		first !== second,
		Object.getPrototypeOf(first) === Number.prototype,
	);
	output.push(derived.valueOf(), Object.getPrototypeOf(derived) === Derived.prototype);
	function Alternate() {}
	const alternate = Reflect.construct(Number, ["23"], Alternate);
	output.push(
		Number.prototype.valueOf.call(alternate),
		Object.getPrototypeOf(alternate) === Alternate.prototype,
	);
	function shadow(Number) {
		return Number("42");
	}
	output.push(shadow(() => "local"));
} else throw new Error("unknown conversion case");
console.log(JSON.stringify(output));
