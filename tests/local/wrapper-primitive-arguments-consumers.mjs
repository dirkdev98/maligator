const results = [];
function record(label, action) {
	try {
		const value = action();
		results.push(label + ":" + (Object.is(value, -0) ? "-0" : String(value)));
	} catch (error) {
		results.push(label + ":" + error.name);
	}
}
function parsedInt(value, radix) {
	return parseInt(new String(value), new Number(radix));
}
function parsedFloat(value) {
	return parseFloat(new String(value));
}
function numberInt(value) {
	return Number.parseInt(new String(value), 16);
}
function numberFloat(value) {
	return Number.parseFloat(new String(value));
}
function numberString(value, digits) {
	return new Number(value).toString(new Number(digits));
}
function fixed(value, digits) {
	return new Number(value).toFixed(new Number(digits));
}
function exponential(value, digits) {
	return new Number(value).toExponential(new Number(digits));
}
function precision(value, digits) {
	return new Number(value).toPrecision(new Number(digits));
}
function signed(bits, value) {
	return BigInt.asIntN(new Number(bits), Object(BigInt(value)));
}
function unsigned(bits, value) {
	return BigInt.asUintN(new Number(bits), Object(BigInt(value)));
}
function bigintString(value, radix) {
	return Object(BigInt(value)).toString(new Number(radix));
}
function symbol(value) {
	return Symbol(new String(value));
}
function registered(value) {
	return Symbol.for(new String(value));
}
function encode(value) {
	return encodeURI(new String(value));
}
function encodeComponent(value) {
	return encodeURIComponent(new String(value));
}
function decode(value) {
	return decodeURI(new String(value));
}
function decodeComponent(value) {
	return decodeURIComponent(new String(value));
}
function legacyEncode(value) {
	return escape(new String(value));
}
function legacyDecode(value) {
	return unescape(new String(value));
}
for (const value of [" -0 ", "12.5e2rest", "0xff", "Infinity", "invalid", ""]) {
	for (const radix of [0, 2, 10, 16, 36, 37])
		record("parseInt", () => parsedInt(value, radix));
	record("parseFloat", () => parsedFloat(value));
	record("Number.parseInt", () => numberInt(value));
	record("Number.parseFloat", () => numberFloat(value));
}
for (const value of [-0, -12.5, 0.125, 16, NaN, Infinity, -Infinity]) {
	for (const digits of [-1, 0, 2, 10, 101]) {
		record("numberString", () => numberString(value, digits));
		record("fixed", () => fixed(value, digits));
		record("exponential", () => exponential(value, digits));
		record("precision", () => precision(value, digits));
	}
}
for (const value of [-257n, -1n, 0n, 255n, 256n]) {
	for (const bits of [-1, 0, 1, 8, 16]) {
		record("signed", () => signed(bits, value));
		record("unsigned", () => unsigned(bits, value));
	}
	for (const radix of [1, 2, 10, 16, 36, 37])
		record("bigintString", () => bigintString(value, radix));
}
for (const value of ["", "a b/?#", "é", "%20%2F", "%", "%ED%A0%80", "\uD800"]) {
	record("encodeURI", () => encode(value));
	record("encodeURIComponent", () => encodeComponent(value));
	record("decodeURI", () => decode(value));
	record("decodeURIComponent", () => decodeComponent(value));
	record("escape", () => legacyEncode(value));
	record("unescape", () => legacyDecode(value));
}
record("symbol-description", () => symbol("value").description);
record("symbol-fresh", () => symbol("value") !== symbol("value"));
record("symbol-registry", () => registered("value") === Symbol.for("value"));
record("symbol-key", () => Symbol.keyFor(registered("value")));
record("keyFor-wrapper", () => Symbol.keyFor(Object(Symbol.for("value"))));
record("symbol-description-wrapper", () => Symbol(Object(Symbol.iterator)));
record("symbol-key-wrapper", () => Symbol.for(Object(Symbol.iterator)));
record("parser-symbol", () => parseInt(Object(Symbol.iterator)));
record("URI-symbol", () => encodeURI(Object(Symbol.iterator)));
record("format-bigint-digits", () => (1).toFixed(Object(2n)));
record("format-symbol-digits", () => (1).toPrecision(Object(Symbol.iterator)));
record("width-number-value", () => BigInt.asIntN(8, new Number(2)));
record("width-bigint-bits", () => BigInt.asIntN(Object(8n), 2n));
record("width-boolean-value", () => BigInt.asUintN(8, new Boolean(true)));
record("width-string-value", () => BigInt.asIntN(8, new String("255")));
const events = [];
const marker = new Error("marker");
const poison = {
	[Symbol.toPrimitive](hint) {
		events.push("poison:" + hint);
		throw marker;
	},
};
function ordered(label, action) {
	events.length = 0;
	try {
		action();
		events.push("returned");
	} catch (error) {
		events.push(error === marker ? "marker" : error.name);
	}
	results.push(label + ":" + events.join(","));
}
ordered("constructor-before-radix", () =>
	parseInt(
		new String({
			[Symbol.toPrimitive](hint) {
				events.push("constructor:" + hint);
				return "12";
			},
		}),
		(events.push("radix-expression"), poison),
	),
);
ordered("format-brand-before-digits", () =>
	Number.prototype.toFixed.call(new Boolean(true), poison),
);
ordered("bigint-brand-before-radix", () =>
	BigInt.prototype.toString.call(new Number(1), poison),
);
ordered("exponential-nonfinite-coercion", () => exponential(Infinity, poison));
ordered("precision-nonfinite-coercion", () => precision(NaN, poison));
ordered("width-zero-still-converts-value", () => BigInt.asIntN(new Number(0), poison));
ordered("invalid-width-before-value", () => BigInt.asUintN(new Number(-1), poison));
ordered("ignored-extra-evaluated", () =>
	encodeURI(new String("a b"), (events.push("extra"), poison)),
);
ordered("constructor-throws-before-extra", () =>
	parseInt(new String(Symbol.iterator), (events.push("extra"), 10)),
);
function ownConversion(value) {
	const wrapper = new String(value);
	wrapper[Symbol.toPrimitive] = () => "ff";
	return parseInt(wrapper, 16);
}
record("own-conversion", () => ownConversion("12"));
function exposed(value) {
	const wrapper = new String(value);
	globalThis.exposedWrapper = wrapper;
	return parseInt(wrapper, 10);
}
record("escaped-value", () => exposed("12"));
const previous = globalThis.exposedWrapper;
exposed("12");
record("escaped-identity", () => previous !== globalThis.exposedWrapper);
if (!Object.isFrozen(String.prototype)) {
	const original = String.prototype.toString;
	try {
		String.prototype.toString = () => "27";
		if (parsedInt("12", 10) !== 27) throw new Error("mutable wrapper conversion");
	} finally {
		String.prototype.toString = original;
	}
	const originalParseInt = Number.parseInt;
	try {
		Number.parseInt = (value) => value instanceof String;
		if (numberInt("12") !== true) throw new Error("mutable consumer identity");
	} finally {
		Number.parseInt = originalParseInt;
	}
}
console.log(results.join("\n"));
