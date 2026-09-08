export const knownBuiltinErrors = {
	symbolNumber: {
		error: "TypeError",
		message: "Cannot convert a Symbol value to a number",
	},
	bigintNumberConversion: {
		error: "TypeError",
		message: "Cannot convert a BigInt value to a number",
	},
	symbolString: {
		error: "TypeError",
		message: "Cannot convert a Symbol value to a string",
	},
	stringNullish: {
		error: "TypeError",
		message: "String.prototype method called on null or undefined",
	},
	stringMatchAllNullish: {
		error: "TypeError",
		message: "String.prototype.matchAll called on null or undefined",
	},
	stringSplitNullish: {
		error: "TypeError",
		message: "String.prototype.split called on null or undefined",
	},
	stringReplaceNullish: {
		error: "TypeError",
		message: "String.prototype.replace called on null or undefined",
	},
	stringReplaceAllNullish: {
		error: "TypeError",
		message: "String.prototype.replaceAll called on null or undefined",
	},
	readNullish: {
		error: "TypeError",
		message: "Cannot read properties of null or undefined",
	},
	notIterable: { error: "TypeError", message: "Value is not iterable" },
	bigintConstructor: { error: "TypeError", message: "BigInt is not a constructor" },
	symbolConstructor: { error: "TypeError", message: "Symbol is not a constructor" },
	notConstructor: { error: "TypeError", message: "Value is not a constructor" },
	numberReceiver: {
		error: "TypeError",
		message: "Number.prototype method called on incompatible receiver",
	},
	booleanReceiver: {
		error: "TypeError",
		message: "Boolean.prototype method called on incompatible receiver",
	},
	bigintReceiver: { error: "TypeError", message: "Receiver is not a BigInt" },
	stringReceiver: {
		error: "TypeError",
		message: "String.prototype.toString called on incompatible receiver",
	},
	symbolReceiver: { error: "TypeError", message: "Receiver is not a symbol" },
	symbolKey: { error: "TypeError", message: "Symbol.keyFor expects a symbol" },
	numberRadix: {
		error: "RangeError",
		message: "toString() radix must be between 2 and 36",
	},
	numberFixed: {
		error: "RangeError",
		message: "toFixed() digits argument must be between 0 and 100",
	},
	numberExponential: {
		error: "RangeError",
		message: "toExponential() argument must be between 0 and 100",
	},
	numberPrecision: {
		error: "RangeError",
		message: "toPrecision() argument must be between 1 and 100",
	},
	bigintNumber: {
		error: "RangeError",
		message: "The number is not a safe integer",
	},
	bigintValue: {
		error: "TypeError",
		message: "Cannot convert value to a BigInt",
	},
	bigintString: {
		error: "SyntaxError",
		message: "Cannot convert string to a BigInt",
	},
	bigintWidth: { error: "RangeError", message: "Invalid bit count" },
	codePoint: { error: "RangeError", message: "Invalid code point" },
	repeatCount: { error: "RangeError", message: "Invalid count value" },
	normalization: {
		error: "RangeError",
		message: "The normalization form should be one of NFC, NFD, NFKC, NFKD",
	},
	uri: { error: "URIError", message: "URI malformed" },
} as const;

export type KnownBuiltinError = keyof typeof knownBuiltinErrors;

export function isKnownBuiltinError(value: unknown): value is KnownBuiltinError {
	return typeof value === "string" && Object.hasOwn(knownBuiltinErrors, value);
}

export function isKnownBuiltinConstructionError(
	value: unknown,
): value is KnownBuiltinError {
	return (
		typeof value === "string" &&
		[
			"notConstructor",
			"bigintConstructor",
			"symbolConstructor",
			"symbolNumber",
			"symbolString",
		].includes(value)
	);
}
