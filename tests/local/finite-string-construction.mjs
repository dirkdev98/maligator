function key(value) {
	return `group${value & 31}`;
}

function unicodeKey(value) {
	return `😀\ud800${(value & 7) - 4}:\udfff`;
}

function callbackKey(value, callback) {
	return callback(`entry${value & 7}`);
}

function branchKey(input) {
	const value = input | 0;
	if (value >= -2 && value < 3) return `branch${value}`;
	return "outside";
}

function loopKeys() {
	const values = [];
	for (let value = -3; value < 4; value++) values.push(`loop${value}`);
	return values;
}

function largeKey(input) {
	return `large${2147483646 + (input & 7)}`;
}

function largeLoopKeys() {
	const values = [];
	for (let value = 2147483646; value < 2147483654; value++) values.push(`large${value}`);
	return values;
}

function largeNegativeLoopKeys() {
	const values = [];
	for (let value = -2147483654; value < -2147483646; value++)
		values.push(`large${value}`);
	return values;
}

function handled(value) {
	try {
		return `handled${value & 7}`;
	} catch (error) {
		return error.name;
	}
}

const scenario = process.env.FINITE_STRING_CASE;
if (scenario === "values") {
	console.log(
		JSON.stringify([-1, 0, 31, 32, 2 ** 31, 4294967295, NaN, Infinity, -0].map(key)),
	);
} else if (scenario === "ranges") {
	console.log(
		JSON.stringify([[-3, -2, -1, 0, 1, 2, 3, NaN, Infinity].map(branchKey), loopKeys()]),
	);
} else if (scenario === "large") {
	console.log(
		JSON.stringify([
			[-1, 0, 1, 2, 3, 7, 8].map(largeKey),
			largeLoopKeys(),
			largeNegativeLoopKeys(),
		]),
	);
} else if (scenario === "unicode") {
	console.log(JSON.stringify([-1, 0, 3, 7, 8].map(unicodeKey)));
} else if (scenario === "coercion") {
	const events = [];
	const value = {
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			return 13;
		},
	};
	console.log(JSON.stringify([key(value), events]));
} else if (scenario === "throws") {
	const errors = [];
	for (const value of [1n, Symbol("finite")]) {
		try {
			key(value);
		} catch (error) {
			errors.push(error.name);
		}
	}
	console.log(JSON.stringify(errors));
} else if (scenario === "fallbacks") {
	const fractional = (value) => `fraction${value / 2}`;
	const unbounded = (value) => `unbounded${value}`;
	console.log(
		JSON.stringify([
			[-1, 1, 3, Infinity, NaN, -0].map(fractional),
			[0, 256, 1e30].map(unbounded),
			handled(7),
			handled(1n),
		]),
	);
} else if (scenario === "callbacks") {
	const values = [];
	for (let index = -8; index < 8; index++)
		values.push(callbackKey(index, (value) => value));
	console.log(JSON.stringify(values));
} else if (scenario === "gc") {
	const retained = [];
	for (let index = 0; index < 512; index++) retained.push(key(index));
	if (typeof gc === "function") gc();
	console.log(
		JSON.stringify([
			retained.length,
			retained.join("|").length,
			retained[31],
			retained[511],
		]),
	);
} else if (scenario === "mutable") {
	let calls = 0;
	Number.prototype.toString = () => {
		calls++;
		return "replaced";
	};
	globalThis.String = () => {
		calls++;
		return "replaced";
	};
	console.log(JSON.stringify([key(13), unicodeKey(7), calls]));
} else {
	throw new Error("Unknown finite string scenario");
}
