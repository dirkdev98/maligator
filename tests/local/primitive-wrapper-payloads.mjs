const results = [],
	events = [],
	escaped = [];
function assert(value) {
	if (!value) throw new Error("wrapper payload invariant");
}
function encode(value) {
	return typeof value === "number"
		? Object.is(value, -0)
			? "number:-0"
			: "number:" + value
		: typeof value + ":" + String(value);
}
function capture(label, fn) {
	try {
		results.push([label, encode(fn())]);
	} catch (error) {
		results.push([label, error.name]);
	}
}
globalThis.sink = function (value) {
	assert(typeof value === "object");
	assert(escaped[escaped.length - 1] !== value);
	escaped.push(value);
	Object.defineProperties(value, {
		valueOf: {
			value() {
				events.push("own valueOf");
				return 99;
			},
			configurable: true,
		},
		toString: {
			value() {
				events.push("own toString");
				return "changed";
			},
			configurable: true,
		},
		[Symbol.toPrimitive]: {
			value(hint) {
				events.push("own " + hint);
				return "changed";
			},
			configurable: true,
		},
	});
	Object.setPrototypeOf(value, null);
};
function booleanValueOf(x) {
	const value = new Boolean(x);
	globalThis.sink(value);
	return Boolean.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.booleanValueOf = booleanValueOf;
function booleanToString(x) {
	const value = new Boolean(x);
	globalThis.sink(value);
	return Boolean.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.booleanToString = booleanToString;
function objectBooleanValueOf(x) {
	const value = Object(!!x);
	globalThis.sink(value);
	return Boolean.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.objectBooleanValueOf = objectBooleanValueOf;
function objectBooleanToString(x) {
	const value = Object(!!x);
	globalThis.sink(value);
	return Boolean.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.objectBooleanToString = objectBooleanToString;
function numberValueOf(x) {
	const value = new Number(+x);
	globalThis.sink(value);
	return Number.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.numberValueOf = numberValueOf;
function numberToString(x) {
	const value = new Number(+x);
	globalThis.sink(value);
	return Number.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.numberToString = numberToString;
function numberToFixed(x) {
	const value = new Number(+x);
	globalThis.sink(value);
	return Number.prototype.toFixed.call(value, undefined, events.push("extra"));
}
globalThis.numberToFixed = numberToFixed;
function numberToExponential(x) {
	const value = new Number(+x);
	globalThis.sink(value);
	return Number.prototype.toExponential.call(value, undefined, events.push("extra"));
}
globalThis.numberToExponential = numberToExponential;
function numberToPrecision(x) {
	const value = new Number(+x);
	globalThis.sink(value);
	return Number.prototype.toPrecision.call(value, undefined, events.push("extra"));
}
globalThis.numberToPrecision = numberToPrecision;
function objectNumberValueOf(x) {
	const value = Object(+x);
	globalThis.sink(value);
	return Number.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.objectNumberValueOf = objectNumberValueOf;
function objectNumberToString(x) {
	const value = Object(+x);
	globalThis.sink(value);
	return Number.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.objectNumberToString = objectNumberToString;
function objectNumberToFixed(x) {
	const value = Object(+x);
	globalThis.sink(value);
	return Number.prototype.toFixed.call(value, undefined, events.push("extra"));
}
globalThis.objectNumberToFixed = objectNumberToFixed;
function objectNumberToExponential(x) {
	const value = Object(+x);
	globalThis.sink(value);
	return Number.prototype.toExponential.call(value, undefined, events.push("extra"));
}
globalThis.objectNumberToExponential = objectNumberToExponential;
function objectNumberToPrecision(x) {
	const value = Object(+x);
	globalThis.sink(value);
	return Number.prototype.toPrecision.call(value, undefined, events.push("extra"));
}
globalThis.objectNumberToPrecision = objectNumberToPrecision;
function stringValueOf(x) {
	const value = new String(String(x));
	globalThis.sink(value);
	return String.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.stringValueOf = stringValueOf;
function stringToString(x) {
	const value = new String(String(x));
	globalThis.sink(value);
	return String.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.stringToString = stringToString;
function objectStringValueOf(x) {
	const value = Object(String(x));
	globalThis.sink(value);
	return String.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.objectStringValueOf = objectStringValueOf;
function objectStringToString(x) {
	const value = Object(String(x));
	globalThis.sink(value);
	return String.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.objectStringToString = objectStringToString;
function objectBigIntValueOf(x) {
	const value = Object(BigInt(x));
	globalThis.sink(value);
	return BigInt.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.objectBigIntValueOf = objectBigIntValueOf;
function objectBigIntToString(x) {
	const value = Object(BigInt(x));
	globalThis.sink(value);
	return BigInt.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.objectBigIntToString = objectBigIntToString;
function objectSymbolValueOf(x) {
	const value = Object(Symbol.for(x));
	globalThis.sink(value);
	return Symbol.prototype.valueOf.call(value, undefined, events.push("extra"));
}
globalThis.objectSymbolValueOf = objectSymbolValueOf;
function objectSymbolToString(x) {
	const value = Object(Symbol.for(x));
	globalThis.sink(value);
	return Symbol.prototype.toString.call(value, undefined, events.push("extra"));
}
globalThis.objectSymbolToString = objectSymbolToString;
function objectSymbolToPrimitive(x) {
	const value = Object(Symbol.for(x));
	globalThis.sink(value);
	return Symbol.prototype[Symbol.toPrimitive].call(
		value,
		undefined,
		events.push("extra"),
	);
}
globalThis.objectSymbolToPrimitive = objectSymbolToPrimitive;
const cases = [
	globalThis.booleanValueOf,
	globalThis.booleanToString,
	globalThis.objectBooleanValueOf,
	globalThis.objectBooleanToString,
	globalThis.numberValueOf,
	globalThis.numberToString,
	globalThis.numberToFixed,
	globalThis.numberToExponential,
	globalThis.numberToPrecision,
	globalThis.objectNumberValueOf,
	globalThis.objectNumberToString,
	globalThis.objectNumberToFixed,
	globalThis.objectNumberToExponential,
	globalThis.objectNumberToPrecision,
	globalThis.stringValueOf,
	globalThis.stringToString,
	globalThis.objectStringValueOf,
	globalThis.objectStringToString,
	globalThis.objectBigIntValueOf,
	globalThis.objectBigIntToString,
	globalThis.objectSymbolValueOf,
	globalThis.objectSymbolToString,
	globalThis.objectSymbolToPrimitive,
];
for (const x of [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	NaN,
	Infinity,
	-Infinity,
	17,
	-1.25,
	"",
	"37",
	"𝌆\ud800",
	0n,
	3n,
	Symbol("s"),
	{
		[Symbol.toPrimitive](hint) {
			events.push("input " + hint);
			return 17;
		},
	},
]) {
	for (let i = 0; i < cases.length; i++) capture(i, () => cases[i](x));
}
for (let i = 0; i < 256; i++) {
	assert(globalThis.booleanValueOf(i % 2) === (i % 2 !== 0));
	assert(globalThis.booleanToString(i % 2) === (i % 2 ? "true" : "false"));
}
function own(x) {
	const v = new Boolean(x);
	globalThis.sink(v);
	return v.valueOf();
}
function generic(x) {
	const v = new String(String(x));
	globalThis.sink(v);
	return String.prototype.slice.call(v, 1);
}
function tag(x) {
	const v = new Boolean(x);
	globalThis.sink(v);
	Object.defineProperty(v, Symbol.toStringTag, { value: "Custom" });
	return Object.prototype.toString.call(v);
}
assert(own(0) === 99);
assert(generic(7) === "hanged");
assert(tag(0) === "[object Custom]");
function mutable(x) {
	const v = new Boolean(x);
	globalThis.sink(v);
	return Boolean.prototype.valueOf.call(v);
}
globalThis.mutable = mutable;
const original = Boolean.prototype.valueOf;
let changed = false;
try {
	Boolean.prototype.valueOf = function () {
		return "override";
	};
	changed = Boolean.prototype.valueOf !== original;
} catch {}
if (changed) {
	assert(globalThis.mutable(0) === "override");
	Boolean.prototype.valueOf = original;
}
const OriginalBoolean = Boolean;
changed = false;
try {
	const replacement = function () {
		return new OriginalBoolean(true);
	};
	replacement.prototype = OriginalBoolean.prototype;
	globalThis.Boolean = replacement;
	changed = Boolean !== OriginalBoolean;
} catch {}
if (changed) {
	assert(globalThis.mutable(0) === true);
	globalThis.Boolean = OriginalBoolean;
}
for (const wrong of [
	new Number(1),
	{},
	Object.create(Boolean.prototype),
	new Proxy(new Boolean(false), {}),
])
	capture("wrong brand", () => Boolean.prototype.valueOf.call(wrong));
function throwing(x) {
	const v = new Boolean(x);
	globalThis.sink(v);
	return Boolean.prototype.valueOf.call(
		v,
		(() => {
			events.push("throwing extra");
			throw new RangeError();
		})(),
	);
}
capture("extra throw", () => throwing(0));
capture("constructor argument throw", () => {
	const v = new Boolean(
		(() => {
			events.push("constructor argument");
			throw new SyntaxError();
		})(),
	);
	globalThis.sink(v);
	return Boolean.prototype.valueOf.call(v);
});
const Target = new Proxy(function () {}, {
	get(target, key, receiver) {
		if (key === "prototype") {
			events.push("newTarget prototype");
			throw new SyntaxError();
		}
		return Reflect.get(target, key, receiver);
	},
});
capture("constructor prototype throw", () =>
	Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [false], Target)),
);
let CatchTarget;
try {
	JSON.parse("!");
} catch {
	CatchTarget = new Proxy(function () {}, {
		get(target, key, receiver) {
			if (key === "prototype") {
				events.push("catch newTarget prototype");
				throw new RangeError();
			}
			return Reflect.get(target, key, receiver);
		},
	});
}
capture("constructor catch prototype throw", () =>
	Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [false], CatchTarget)),
);
function numberCoercion(x) {
	const v = new Number(x);
	globalThis.sink(v);
	return Number.prototype.valueOf.call(v);
}
function stringCoercion(x) {
	const v = new String(x);
	globalThis.sink(v);
	return String.prototype.valueOf.call(v);
}
let calls = 0;
const input = {
	[Symbol.toPrimitive](hint) {
		calls++;
		events.push(hint);
		return 23;
	},
};
assert(numberCoercion(input) === 23);
assert(stringCoercion(input) === "23");
assert(calls === 2);
function fromPhi(x) {
	const v = x ? new Boolean(false) : new Number(3);
	globalThis.sink(v);
	return Boolean.prototype.valueOf.call(v);
}
capture("phi boolean", () => fromPhi(true));
capture("phi number", () => fromPhi(false));
function conditionalBoolean(x, flag) {
	const value = new Boolean(!!x, events.push("boolean argument"));
	if (flag) globalThis.sink(value);
	return Boolean.prototype.valueOf.call(value);
}
function conditionalNumber(x, flag) {
	const value = new Number(+x, events.push("number argument"));
	if (flag) globalThis.sink(value);
	return Number.prototype.valueOf.call(value);
}
function conditionalString(x, flag) {
	const value = new String(String(x), events.push("string argument"));
	if (flag) globalThis.sink(value);
	return String.prototype.valueOf.call(value);
}
function conditionalObject(x, flag) {
	const value = Object(+x, events.push("object argument"));
	if (flag) globalThis.sink(value);
	return Number.prototype.valueOf.call(value);
}
function conditionalCoercion(x, flag) {
	const value = new Number(x);
	if (flag) globalThis.sink(value);
	return Number.prototype.valueOf.call(value);
}
function conditionalStringCoercion(x, flag) {
	const value = new String(x);
	if (flag) globalThis.sink(value);
	return String.prototype.valueOf.call(value);
}
globalThis.conditionalWrappers = [
	conditionalBoolean,
	conditionalNumber,
	conditionalString,
	conditionalObject,
	conditionalCoercion,
	conditionalStringCoercion,
];
for (const flag of [false, true, false, true]) {
	for (const value of [0, -0, NaN, 1.25, "𝌆\ud800", input]) {
		for (const [index, fn] of globalThis.conditionalWrappers.entries())
			capture("conditional " + index + " " + flag, () => fn(value, flag));
	}
	const throwingInput = {
		[Symbol.toPrimitive]() {
			events.push("conditional coercion throw");
			throw new RangeError();
		},
	};
	capture("conditional normalized throw", () => conditionalNumber(throwingInput, flag));
	capture("conditional constructor throw", () =>
		conditionalCoercion(throwingInput, flag),
	);
}

const convertedCases = [];
function mutateInput(wrapper, input) {
	globalThis.sink(wrapper);
	events.push("escape");
	if (input !== null && typeof input === "object") {
		input[Symbol.toPrimitive] = function () {
			throw new Error("conversion repeated after construction");
		};
	}
}
globalThis.mutateInput = mutateInput;

function convertedBooleanvalueOf(x, option) {
	const wrapper = new Boolean(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Boolean.prototype.valueOf.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedBooleanvalueOf = convertedBooleanvalueOf;
convertedCases.push(globalThis.convertedBooleanvalueOf);

function convertedBooleantoString(x, option) {
	const wrapper = new Boolean(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Boolean.prototype.toString.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedBooleantoString = convertedBooleantoString;
convertedCases.push(globalThis.convertedBooleantoString);

function convertedNumbervalueOf(x, option) {
	const wrapper = new Number(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Number.prototype.valueOf.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedNumbervalueOf = convertedNumbervalueOf;
convertedCases.push(globalThis.convertedNumbervalueOf);

function convertedNumbertoString(x, option) {
	const wrapper = new Number(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Number.prototype.toString.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedNumbertoString = convertedNumbertoString;
convertedCases.push(globalThis.convertedNumbertoString);

function convertedNumbertoFixed(x, option) {
	const wrapper = new Number(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Number.prototype.toFixed.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedNumbertoFixed = convertedNumbertoFixed;
convertedCases.push(globalThis.convertedNumbertoFixed);

function convertedNumbertoExponential(x, option) {
	const wrapper = new Number(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Number.prototype.toExponential.call(
		wrapper,
		option,
		events.push("reader extra"),
	);
}
globalThis.convertedNumbertoExponential = convertedNumbertoExponential;
convertedCases.push(globalThis.convertedNumbertoExponential);

function convertedNumbertoPrecision(x, option) {
	const wrapper = new Number(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return Number.prototype.toPrecision.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedNumbertoPrecision = convertedNumbertoPrecision;
convertedCases.push(globalThis.convertedNumbertoPrecision);

function convertedStringvalueOf(x, option) {
	const wrapper = new String(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return String.prototype.valueOf.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedStringvalueOf = convertedStringvalueOf;
convertedCases.push(globalThis.convertedStringvalueOf);

function convertedStringtoString(x, option) {
	const wrapper = new String(x, events.push("constructor extra"));
	globalThis.mutateInput(wrapper, x);
	return String.prototype.toString.call(wrapper, option, events.push("reader extra"));
}
globalThis.convertedStringtoString = convertedStringtoString;
convertedCases.push(globalThis.convertedStringtoString);

function defaultBoolean() {
	const wrapper = new Boolean();
	globalThis.sink(wrapper);
	return Boolean.prototype.valueOf.call(wrapper);
}
globalThis.defaultBoolean = defaultBoolean;
capture("default Boolean", () => globalThis.defaultBoolean());

function defaultNumber() {
	const wrapper = new Number();
	globalThis.sink(wrapper);
	return Number.prototype.valueOf.call(wrapper);
}
globalThis.defaultNumber = defaultNumber;
capture("default Number", () => globalThis.defaultNumber());

function defaultString() {
	const wrapper = new String();
	globalThis.sink(wrapper);
	return String.prototype.valueOf.call(wrapper);
}
globalThis.defaultString = defaultString;
capture("default String", () => globalThis.defaultString());

for (const [index, fn] of convertedCases.entries()) {
	for (const primitive of [
		undefined,
		null,
		false,
		true,
		-0,
		NaN,
		Infinity,
		17,
		"23",
		"𝌆\ud800",
		3n,
		Symbol("converted"),
	])
		capture("converted " + index, () => fn(primitive, 2));
	for (const mode of ["number", "bigint", "symbol", "throw"]) {
		const input = {
			[Symbol.toPrimitive](hint) {
				events.push("convert " + hint);
				if (mode === "throw") throw new RangeError("conversion");
				return mode === "bigint" ? 23n : mode === "symbol" ? Symbol("converted") : 23;
			},
		};
		const option = {
			valueOf() {
				events.push("option");
				return 2;
			},
		};
		capture("converted effect " + index + " " + mode, () => fn(input, option));
	}
}
function customNumberTarget(x, Target) {
	const wrapper = Reflect.construct(Number, [x], Target);
	globalThis.sink(wrapper);
	return Number.prototype.valueOf.call(wrapper);
}
function customStringTarget(x, Target) {
	const wrapper = Reflect.construct(String, [x], Target);
	globalThis.sink(wrapper);
	return String.prototype.valueOf.call(wrapper);
}
globalThis.customNumberTarget = customNumberTarget;
globalThis.customStringTarget = customStringTarget;
for (const construct of [globalThis.customNumberTarget, globalThis.customStringTarget]) {
	for (const Target of [
		null,
		() => {},
		new Proxy(function () {}, {
			get(target, key, receiver) {
				events.push("target " + String(key));
				if (key === "prototype") throw new SyntaxError("prototype");
				return Reflect.get(target, key, receiver);
			},
		}),
	]) {
		capture("custom target", () =>
			construct(
				{
					[Symbol.toPrimitive](hint) {
						events.push("custom " + hint);
						return 7;
					},
				},
				Target,
			),
		);
	}
}
console.log(JSON.stringify({ results, events }));
