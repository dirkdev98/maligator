export const knownBuiltinErrors = {
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
