const results = [];
const events = [];

function collect() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}

function extra(name) {
	events.push(name);
	collect();
	return 99;
}

function record(value) {
	results.push(typeof value === "number" && Object.is(value, -0) ? "-0" : String(value));
}

function numberUnion(input, flag) {
	return Number(flag ? +input : undefined, extra("number-extra"));
}

function stringUnion(input, flag) {
	return String(flag ? +input : undefined, extra("string-extra"));
}

function stringBigInt(input, flag) {
	const value = flag ? BigInt(input) : undefined;
	const text = String(value);
	collect();
	return text + ":" + String(value);
}

function numberText(input, flag) {
	const value = flag ? String(input) : undefined;
	return Number(value);
}

function primitiveUnion(input, selector) {
	let value =
		selector === 0
			? +input
			: selector === 1
				? undefined
				: selector === 2
					? null
					: !!input;
	const number = Number(value);
	const text = String(value);
	record(number);
	record(text);
	record(-value);
	record(~value);
	record(value++);
	record(value);
}

function primitiveText(input, selector) {
	let value =
		selector === 0
			? String(input)
			: selector === 1
				? undefined
				: selector === 2
					? null
					: !!input;
	record(Number(value));
	record(String(value));
	record(-value);
	record(~value);
	record(++value);
	record(value--);
}

function fastNumber(flag) {
	return Number(flag ? 12.5 : undefined);
}

function objectText(value, flag) {
	return String(
		flag
			? {
					[Symbol.toPrimitive](hint) {
						events.push(hint);
						collect();
						return value;
					},
				}
			: undefined,
		extra("object-extra"),
	);
}

function objectNumber(value) {
	return Number(
		{
			[Symbol.toPrimitive](hint) {
				events.push(hint);
				collect();
				return value;
			},
		},
		extra("numeric-object-extra"),
	);
}

function numberBigInt(input, flag) {
	return Number(flag ? BigInt(input) : undefined);
}

function stringSymbol(input, flag) {
	return String(flag ? Symbol.for(input) : undefined);
}

function numberSymbol(input, flag) {
	return Number(flag ? Symbol.for(input) : undefined, extra("symbol-extra"));
}

function caught(run) {
	try {
		record(run());
	} catch (error) {
		record(error.name);
	}
}

Object.assign(globalThis, {
	numberUnion,
	stringUnion,
	stringBigInt,
	numberText,
	primitiveUnion,
	primitiveText,
	fastNumber,
	objectText,
	objectNumber,
	numberBigInt,
	stringSymbol,
	numberSymbol,
});

for (const input of [-0, 0, -1.5, 2147483648, 4294967297, Infinity, -Infinity, NaN]) {
	for (const flag of [false, true]) {
		record(numberUnion(input, flag));
		record(stringUnion(input, flag));
		record(numberText(input, flag));
		record(fastNumber(flag));
	}
	for (let selector = 0; selector < 4; selector++) primitiveUnion(input, selector);
}

for (const input of [
	"",
	"  -0  ",
	"\u200312.5\uFEFF",
	"0x100",
	"invalid",
	"Infinity",
	"1\u00002",
]) {
	for (let selector = 0; selector < 4; selector++) primitiveText(input, selector);
	for (const flag of [false, true]) record(numberText(input, flag));
}

for (const input of ["0", "-17", "9007199254740993"]) {
	for (const flag of [false, true]) {
		record(stringBigInt(input, flag));
		record(numberBigInt(input, flag));
		record(stringSymbol(input, flag));
		caught(() => numberSymbol(input, flag));
	}
}

for (const value of ["text", -0, 17n, Symbol.for("converted"), {}]) {
	for (const flag of [false, true]) caught(() => objectText(value, flag));
	caught(() => objectNumber(value));
}

caught(() =>
	Number(
		1,
		(() => {
			events.push("extra-throws");
			throw new RangeError();
		})(),
	),
);
caught(() =>
	String(
		1,
		(() => {
			events.push("text-extra-throws");
			throw new RangeError();
		})(),
	),
);
record(Number());
record(String());
record(new Number(-0).valueOf());
record(new String(17n).valueOf());
caught(() => new String(Symbol.for("wrapper")));
record(Number(...["12.5", extra("spread-number")]));
record(String(...[Symbol.for("spread"), extra("spread-string")]));

console.log(results.join("|"));
console.log(events.join("|"));
