const gc = globalThis.__mal_collect_garbage ?? (() => {});

function composedPhiArithmetic(condition, left, right) {
	const a = +left;
	const b = +right;
	return condition ? (a - b) * 2 : (a + b) * 3;
}
function composedPhiRotation(left, right, count) {
	let a = +left;
	let b = +right;
	const rounds = +count;
	for (let index = 0; index < rounds; index = index + 1) {
		const next = (a - b) * 2;
		a = b;
		b = next;
	}
	return a + b;
}
globalThis.composedPhiArithmetic = composedPhiArithmetic;
globalThis.composedPhiRotation = composedPhiRotation;
for (const [left, right] of [
	[-0, 0],
	[-0, -0],
	[0, -0],
	[NaN, 1],
	[Infinity, -Infinity],
	[Number.MIN_VALUE, 0],
	[1e308, -1e308],
	[7, 3],
]) {
	for (const condition of [false, true]) {
		const value = composedPhiArithmetic(condition, left, right);
		gc();
		console.log("composed-phi", String(value), Object.is(value, -0));
	}
	for (const rounds of [0, 1, 1.5, 2, 6]) {
		const value = composedPhiRotation(left, right, rounds);
		gc();
		console.log("composed-phi-rotation", String(value), Object.is(value, -0));
	}
}

function composedIndexedLoad(values, left, right) {
	const a = +left;
	const b = +right;
	return values[(a - b) * 2];
}
globalThis.composedIndexedLoad = composedIndexedLoad;
const composedIndexedOrder = [];
const composedIndexedSentinel = {};
const composedIndexedObject = {
	get 0() {
		composedIndexedOrder.push("getter");
		gc();
		return { value: "getter-value" };
	},
	get 2() {
		gc();
		throw composedIndexedSentinel;
	},
	"-1": "negative",
	0.5: "fractional",
	NaN: "not-a-number",
	Infinity: "positive-infinity",
	"-Infinity": "negative-infinity",
	4294967295: "not-an-array-index",
};
const composedIndexedProxy = new Proxy(composedIndexedObject, {
	get(target, key, receiver) {
		composedIndexedOrder.push(`proxy:${String(key)}`);
		gc();
		return Reflect.get(target, key, receiver);
	},
});
const composedIndexedPrototype = Object.create(Array.prototype);
Object.defineProperty(composedIndexedPrototype, "1", {
	get() {
		gc();
		return { value: "inherited-hole" };
	},
});
const composedInheritedHole = ["zero", , "two"];
Object.setPrototypeOf(composedInheritedHole, composedIndexedPrototype);
for (const values of [
	["zero", "one", "two"],
	["zero", , "two"],
	composedInheritedHole,
	composedIndexedObject,
	composedIndexedProxy,
	new Int16Array([7, -3, 9]),
]) {
	for (const left of [
		-0,
		0.25,
		0.5,
		-0.5,
		1,
		3,
		NaN,
		Infinity,
		-Infinity,
		2147483647.5,
	]) {
		try {
			const value = composedIndexedLoad(values, left, 0);
			gc();
			console.log(
				"composed-indexed-load",
				typeof value === "object" && value !== null ? value.value : String(value),
			);
		} catch (error) {
			console.log("composed-indexed-throw", error === composedIndexedSentinel);
		}
	}
}
console.log("composed-indexed-order", composedIndexedOrder.join(":"));
const composedMutatedReceiver = ["before"];
console.log(
	"composed-indexed-coercion-mutation",
	composedIndexedLoad(composedMutatedReceiver, 0, {
		valueOf() {
			gc();
			composedMutatedReceiver[0] = "after";
			return 0;
		},
	}),
);

function composedPredicateResult(left, right) {
	const a = +left;
	const b = +right;
	return Number.isSafeInteger((a - b) * 2);
}
function composedCodesResult(left, right) {
	const a = +left;
	const b = +right;
	return String.fromCharCode((a - b) * 2);
}
function composedRadixResult(left, right) {
	const a = +left;
	const b = +right;
	return 1234n.toString((a - b) * 2);
}
function composedQueryNeedle(left, right, from) {
	const a = +left;
	const b = +right;
	return [1, , undefined, NaN, -0, 1, "equal", 5n].indexOf((a - b) * 2, from);
}
function composedQueryFrom(left, right, input) {
	const a = +left;
	const b = +right;
	return [1, , undefined, NaN, -0, 1, "equal", 5n].indexOf(input, (a - b) * 2);
}
function composedCompareResult(left, right) {
	const a = +left;
	const b = +right;
	return "a".localeCompare((a - b) * 2);
}
function composedArrayElements(left, right) {
	const a = +left;
	const b = +right;
	return [a - b, , a + 1.5];
}
globalThis.composedPredicateResult = composedPredicateResult;
globalThis.composedCodesResult = composedCodesResult;
globalThis.composedRadixResult = composedRadixResult;
globalThis.composedQueryNeedle = composedQueryNeedle;
globalThis.composedQueryFrom = composedQueryFrom;
globalThis.composedCompareResult = composedCompareResult;
globalThis.composedArrayElements = composedArrayElements;
for (const [left, right] of [
	[4, 1],
	[-0, 0],
	[1.75, 0.25],
	[Infinity, 1],
	[-Infinity, 1],
	[NaN, 2],
	[9007199254740991, 0],
]) {
	const values = composedArrayElements(left, right);
	gc();
	console.log(
		"composed-helpers",
		composedPredicateResult(left, right),
		JSON.stringify(composedCodesResult(left, right)),
		composedQueryNeedle(left, right, -8),
		composedQueryFrom(left, right, 1),
		composedCompareResult(left, right),
		String(values[0]),
		Object.is(values[0], -0),
		String(values[2]),
		values.length,
		1 in values,
		Object.hasOwn(values, 1),
	);
	try {
		console.log("composed-radix", composedRadixResult(left, right));
	} catch (error) {
		console.log("composed-radix", error instanceof RangeError);
	}
}
const composedOrder = [];
const composedCoercible = (name, value) => ({
	valueOf() {
		composedOrder.push(name);
		gc();
		return value;
	},
});
console.log(
	"composed-coercion",
	composedQueryNeedle(
		composedCoercible("left", 3),
		composedCoercible("right", 3),
		composedCoercible("from", -8),
	),
	composedOrder.join(":"),
);
const composedSentinel = {};
try {
	composedPredicateResult(composedCoercible("before-throw", 3), {
		valueOf() {
			gc();
			throw composedSentinel;
		},
	});
} catch (error) {
	console.log("composed-throw", error === composedSentinel);
}
for (const input of [1n, Symbol("composed")]) {
	try {
		composedCodesResult(input, 0);
	} catch (error) {
		console.log("composed-type-error", error instanceof TypeError);
	}
}

let argumentDefaults = 0;
function argumentCountResult(value = (++argumentDefaults, 7)) {
	const count = arguments.length;
	value = 99;
	gc();
	return [count + 1.5, value, arguments[0]];
}
function restLengthResult(left, right, ...rest) {
	const length = rest.length;
	gc();
	return length + 1.5;
}
function* suspendedArgumentCount() {
	const count = arguments.length;
	yield count + 1.5;
	gc();
	return count + 2.5;
}
globalThis.argumentCountResult = argumentCountResult;
globalThis.restLengthResult = restLengthResult;
globalThis.suspendedArgumentCount = suspendedArgumentCount;
for (const args of [[], [undefined], [3], [3, 4, 5, 6]]) {
	console.log(
		"argument-count",
		JSON.stringify(argumentCountResult(...args)),
		argumentDefaults,
	);
	console.log("rest-length", restLengthResult(...args));
	const generator = suspendedArgumentCount(...args);
	console.log("suspended-argument-count", JSON.stringify(generator.next()));
	gc();
	console.log("suspended-argument-count", JSON.stringify(generator.next()));
}

function staticIndexResult(input, from) {
	const value = [1, , undefined, NaN, -0, 1, "equal", 5n].indexOf(input, from);
	gc();
	return value + 1.5;
}
function staticLastIndexResult(input, from) {
	const value = [1, , undefined, NaN, -0, 1, "equal", 5n].lastIndexOf(input, from);
	gc();
	return value + 1.5;
}
function staticIncludesResult(input, from) {
	const value = [1, , undefined, NaN, -0, 1, "equal", 5n].includes(input, from);
	gc();
	return !value;
}
function primitiveLengthResult(input) {
	const value = String(input).length;
	gc();
	return value + 1.5;
}
function preparedCompareResult(left, right) {
	const value = String(left).localeCompare(right);
	gc();
	return value + 1.5;
}
function certifiedArrayLengthResult(rounds) {
	const values = Array.from({ length: 64 }, (_, index) => index);
	values[0] = "x";
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < values.length; index++) checksum += index;
	}
	return checksum;
}
globalThis.staticIndexResult = staticIndexResult;
globalThis.staticLastIndexResult = staticLastIndexResult;
globalThis.staticIncludesResult = staticIncludesResult;
globalThis.primitiveLengthResult = primitiveLengthResult;
globalThis.preparedCompareResult = preparedCompareResult;
globalThis.certifiedArrayLengthResult = certifiedArrayLengthResult;
for (const rounds of [0, 1, 3])
	console.log("certified-array-length", certifiedArrayLengthResult(rounds));
for (const input of [undefined, NaN, -0, 1, 5n, "equal", {}])
	for (const from of [undefined, -0, -8, -1, 1.75, 100, Infinity, -Infinity, NaN])
		console.log(
			"static-query",
			String(input),
			String(from),
			staticIndexResult(input, from),
			staticLastIndexResult(input, from),
			staticIncludesResult(input, from),
		);
for (const input of ["", "abc", "a😀b", "\ud800", -0, 5n, Symbol("length")])
	console.log("primitive-length", primitiveLengthResult(input));
for (const [left, right] of [
	["a", "a"],
	["a", "b"],
	["b", "a"],
])
	console.log("prepared-compare", preparedCompareResult(left, right));
const scalarResultOrder = [];
const scalarResultFrom = {
	valueOf() {
		scalarResultOrder.push("from");
		gc();
		return -2;
	},
};
console.log(
	"static-query-coercion",
	staticIndexResult(5n, scalarResultFrom),
	staticLastIndexResult(1, scalarResultFrom),
	staticIncludesResult(NaN, scalarResultFrom),
	scalarResultOrder.join(":"),
);
const scalarResultSentinel = {};
for (const operation of [
	staticIndexResult,
	staticLastIndexResult,
	staticIncludesResult,
]) {
	try {
		operation(1, {
			valueOf() {
				gc();
				throw scalarResultSentinel;
			},
		});
	} catch (error) {
		console.log("static-query-throw", error === scalarResultSentinel);
	}
	for (const from of [1n, Symbol("from")]) {
		try {
			operation(1, from);
		} catch (error) {
			console.log("static-query-type-error", error instanceof TypeError);
		}
	}
}
for (const operation of [primitiveLengthResult, preparedCompareResult]) {
	try {
		operation(
			{
				toString() {
					gc();
					throw scalarResultSentinel;
				},
			},
			"a",
		);
	} catch (error) {
		console.log("string-result-throw", error === scalarResultSentinel);
	}
}
console.log(
	"prepared-right-coercion",
	preparedCompareResult("a", {
		toString() {
			gc();
			return "b";
		},
	}),
);
try {
	preparedCompareResult("a", {
		toString() {
			gc();
			throw scalarResultSentinel;
		},
	});
} catch (error) {
	console.log("prepared-right-throw", error === scalarResultSentinel);
}

function knownNumberResult(input) {
	const value = Number(input);
	gc();
	return [value + 1.5, Object.is(value, -0)];
}
function knownParseResult(input, radix) {
	const value = parseInt(input, radix);
	const fraction = Number.parseFloat(input);
	gc();
	return value + fraction;
}
function knownCodeResult(position) {
	const value = "abc".charCodeAt(position);
	gc();
	return value + 1.5;
}
function cachedCodeResult(position) {
	const value = "abc".charCodeAt(+position);
	return value + 1.5;
}
function knownBooleanResults(input) {
	const finite = Number.isFinite(input);
	const integer = Number.isInteger(input);
	const safe = Number.isSafeInteger(input);
	gc();
	return [!finite, !integer, !safe, !isFinite(input), !isNaN(input)];
}
globalThis.knownNumberResult = knownNumberResult;
globalThis.knownParseResult = knownParseResult;
globalThis.knownCodeResult = knownCodeResult;
globalThis.cachedCodeResult = cachedCodeResult;
globalThis.knownBooleanResults = knownBooleanResults;
for (const input of [-0, NaN, Infinity, -Infinity, 1.75, 1n, "7.5"]) {
	console.log("known-number", String(input), JSON.stringify(knownNumberResult(input)));
	console.log("known-parse", String(input), String(knownParseResult(input, 10)));
}
for (const position of [undefined, -1, 0, 1.75, 100, NaN, Infinity])
	console.log(
		"known-code",
		String(position),
		String(knownCodeResult(position)),
		String(cachedCodeResult(position)),
	);
for (const input of [-0, NaN, Infinity, 1.75, "7", {}, undefined])
	console.log("known-boolean", String(input), JSON.stringify(knownBooleanResults(input)));
const knownOrder = [];
const knownCoercion = {
	valueOf() {
		knownOrder.push("number");
		gc();
		return -0;
	},
	toString() {
		knownOrder.push("string");
		gc();
		return "7.5";
	},
};
console.log(
	"known-coercion",
	JSON.stringify(knownNumberResult(knownCoercion)),
	knownParseResult(knownCoercion, 10),
	knownCodeResult(knownCoercion),
	knownOrder.join(":"),
);
const knownSentinel = {};
for (const operation of [
	knownNumberResult,
	knownParseResult,
	knownCodeResult,
	cachedCodeResult,
	knownBooleanResults,
]) {
	try {
		operation({
			valueOf() {
				gc();
				throw knownSentinel;
			},
			toString() {
				gc();
				throw knownSentinel;
			},
		});
	} catch (error) {
		console.log("known-throw", error === knownSentinel);
	}
}
for (const operation of [
	knownNumberResult,
	knownParseResult,
	knownCodeResult,
	cachedCodeResult,
]) {
	try {
		operation(Symbol("known"));
	} catch (error) {
		console.log("known-symbol", error instanceof TypeError);
	}
}
for (const operation of [knownCodeResult, cachedCodeResult]) {
	try {
		operation(1n);
	} catch (error) {
		console.log("known-code-bigint", error instanceof TypeError);
	}
}

function immediateReturnedFields(payload, numeric, label) {
	return { numeric: numeric + 1.5, payload, label };
}
globalThis.immediateReturnedFields = immediateReturnedFields;
for (let i = 0; i < 24; i++) {
	const payload = { marker: i, text: `payload-${i}-${"x".repeat(80)}` };
	const label = `label-${i}-${"y".repeat(80)}`;
	const first = immediateReturnedFields(payload, i, label);
	const second = immediateReturnedFields(payload, i, label);
	gc();
	first.numeric = -1;
	const descriptor = Object.getOwnPropertyDescriptor(second, "payload");
	console.log(
		"immediate-fields",
		first !== second,
		second.numeric,
		second.payload === payload,
		second.payload.marker,
		second.payload.text.length,
		second.label === label,
		Object.getPrototypeOf(second) === Object.prototype,
		descriptor.writable,
		descriptor.enumerable,
		descriptor.configurable,
	);
}

function boundedUnsigned(left) {
	const value = left & 65535;
	return (value * 3 + 1) % 101;
}
function composedSigned(left) {
	const value = left | 0;
	return (~value >> 3) ^ value;
}
globalThis.boundedUnsigned = boundedUnsigned;
globalThis.composedSigned = composedSigned;
for (const input of [
	-0,
	NaN,
	Infinity,
	-Infinity,
	-2147483648,
	2147483647,
	4294967295,
	4294967296,
	1.75,
])
	console.log(
		"integer-expression",
		String(input),
		boundedUnsigned(input),
		composedSigned(input),
	);
const numericModeOrder = [];
const numericModeInput = {
	valueOf() {
		numericModeOrder.push("valueOf");
		gc();
		return -17;
	},
};
console.log(
	"integer-coercion",
	boundedUnsigned(numericModeInput),
	composedSigned(numericModeInput),
	numericModeOrder.join(":"),
);
for (const operation of [boundedUnsigned, composedSigned]) {
	try {
		operation(1n);
	} catch (error) {
		console.log("integer-bigint", error instanceof TypeError);
	}
}

function joinedFieldStorage(input, replacement) {
	const o = { numeric: 2, payload: input, label: "old", flag: true };
	if (replacement) {
		o.numeric = 1.5;
		o.payload = replacement;
		o.label = "new";
		o.flag = false;
	}
	gc();
	return o === input ? null : [o.numeric, o.payload.value, o.label, o.flag];
}
globalThis.joinedFieldStorage = joinedFieldStorage;
console.log("joined-fields", JSON.stringify(joinedFieldStorage({ value: 3 }, null)));
console.log(
	"joined-fields",
	JSON.stringify(joinedFieldStorage({ value: 3 }, { value: 9 })),
);

function materializeProvenFields(input, later) {
	const value = +input;
	return {
		numeric: value + 1.5,
		zero: value * 1,
		flag: value < 1.5,
		label: typeof input,
		later: later(),
	};
}
globalThis.materializeProvenFields = materializeProvenFields;
for (const input of [-0, NaN, Infinity, -Infinity, 1.75]) {
	const value = materializeProvenFields(input, () => {
		gc();
		return { value: 7 };
	});
	console.log(
		"heap-fields",
		String(value.numeric),
		Object.is(value.zero, -0),
		value.flag,
		value.label,
		value.later.value,
	);
}
const fieldOrder = [];
const fieldInput = {
	valueOf() {
		fieldOrder.push("coerce");
		gc();
		return 4;
	},
};
console.log(
	"field-order",
	materializeProvenFields(fieldInput, () => {
		fieldOrder.push("later");
		gc();
		return 8;
	}).numeric,
	fieldOrder.join(":"),
);
try {
	materializeProvenFields(1n, () => {
		fieldOrder.push("wrong");
		return 0;
	});
} catch (error) {
	console.log("field-bigint", error instanceof TypeError, fieldOrder.join(":"));
}

function storeProvenFields(object, input, key) {
	const value = +input;
	object.numeric = value + 1.5;
	object[key] = value < 1.5;
	return [object.numeric, object[key]];
}
globalThis.storeProvenFields = storeProvenFields;
const storeOrder = [];
const storeTarget = new Proxy(
	{},
	{
		set(target, key, value) {
			storeOrder.push(`${String(key)}:${String(value)}`);
			gc();
			target[key] = value;
			return true;
		},
	},
);
console.log(
	"scalar-field-stores",
	JSON.stringify(storeProvenFields(storeTarget, fieldInput, "flag")),
	storeOrder.join(":"),
);
const storeFailure = {};
try {
	storeProvenFields(
		new Proxy(
			{},
			{
				set() {
					throw storeFailure;
				},
			},
		),
		3,
		"flag",
	);
} catch (error) {
	console.log("scalar-store-throw", error === storeFailure);
}

function composeBoundaryValues(left, right, callback, key) {
	const a = +left;
	const b = +right;
	callback(a - b);
	callback({ difference: a - b, flag: a < b });
	const object = {};
	object.numeric = a - b;
	object[key] = a < b;
	return object;
}
globalThis.composeBoundaryValues = composeBoundaryValues;
const boundaryOrder = [];
const boundaryResult = composeBoundaryValues(
	{
		valueOf() {
			boundaryOrder.push("left");
			gc();
			return 3.5;
		},
	},
	{
		valueOf() {
			boundaryOrder.push("right");
			gc();
			return 1;
		},
	},
	(value) => {
		boundaryOrder.push(typeof value === "number" ? String(value) : JSON.stringify(value));
		gc();
	},
	"flag",
);
console.log(
	"composed-boundaries",
	JSON.stringify(boundaryResult),
	boundaryOrder.join(":"),
);

const preservedBoundaryZero = composeBoundaryValues(
	{
		valueOf() {
			gc();
			return -0;
		},
	},
	0,
	(value) => {
		gc();
	},
	"flag",
);
console.log("boundary-zero", Object.is(preservedBoundaryZero.numeric, -0));
let boundaryConsumerRuns = 0;
const boundaryFailure = {};
for (const input of [
	1n,
	Symbol("input"),
	{
		valueOf() {
			gc();
			throw boundaryFailure;
		},
	},
]) {
	try {
		composeBoundaryValues(
			input,
			0,
			() => {
				boundaryConsumerRuns++;
			},
			"flag",
		);
	} catch (error) {
		console.log(
			"boundary-coercion-throw",
			error === boundaryFailure,
			error instanceof TypeError,
			boundaryConsumerRuns,
		);
	}
}

globalThis.makeStorageValue = (value) => ({ value, padding: new Array(300).fill(value) });

globalThis.rotateStorage = (left, right, count) => {
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
		gc();
	}
	return `${left.value}:${right.value}`;
};
for (const count of [0, 1, 4])
	console.log(
		"rotate",
		count,
		globalThis.rotateStorage(
			globalThis.makeStorageValue(2),
			globalThis.makeStorageValue(9),
			count,
		),
	);

function rotateScalars(left, right, third, fourth, count) {
	for (let index = 0; index < count; index++) {
		const first = left;
		left = right;
		right = first;
		const second = third;
		third = fourth;
		fourth = second;
	}
	for (let index = 0; index < count - 1; index++) {
		const first = left;
		left = right;
		right = first;
		const second = third;
		third = fourth;
		fourth = second;
	}
	return [left, right, third, fourth];
}
globalThis.rotateScalars = rotateScalars;
for (const count of [0, 1, 4]) {
	const values = rotateScalars(-0, 0 / 0, 1 / 0, -1 / 0, count);
	console.log(
		"scalar-rotation",
		count,
		values
			.map((value) =>
				Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value),
			)
			.join(":"),
	);
}

function rotateFlags(left, right, count) {
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
	}
	return left;
}
globalThis.rotateFlags = rotateFlags;
for (const count of [0, 1, 4])
	console.log("boolean-rotation", count, rotateFlags(true, false, count));

function readEarly(early) {
	if (early) return value;
	let value = 17;
	return value;
}

function projectScalarStorage(value, left, right, count) {
	const total = value.left + value.right;
	for (let index = 0; index < count; index++) {
		const saved = left;
		left = right;
		right = saved;
	}
	return [total, left, right];
}
globalThis.projectScalarStorage = projectScalarStorage;
for (const count of [0, 1, 4])
	console.log(
		"project-scalars",
		projectScalarStorage({ left: 3, right: 7 }, 2, 9, count).join(":"),
	);
const propertyOrder = [];
const projectionAccessor = {
	get left() {
		propertyOrder.push("left");
		gc();
		return 11;
	},
	get right() {
		propertyOrder.push("right");
		gc();
		return 13;
	},
};
console.log(
	"project-getters",
	projectScalarStorage(projectionAccessor, 2, 9, 1).join(":"),
);
const projectionProxy = new Proxy(
	{ left: 17, right: 19 },
	{
		get(target, key) {
			propertyOrder.push(key);
			gc();
			return target[key];
		},
	},
);
console.log("project-proxy", projectScalarStorage(projectionProxy, 2, 9, 1).join(":"));
try {
	projectScalarStorage(
		{
			get left() {
				propertyOrder.push("throw-left");
				gc();
				throw new Error("projection-throw");
			},
			get right() {
				throw new Error("unexpected second getter");
			},
		},
		2,
		9,
		1,
	);
	throw new Error("projection failed to throw");
} catch (error) {
	console.log("project-error", error.message);
}
console.log("project-order", propertyOrder.join(":"));
globalThis.readEarly = readEarly;
for (const early of [false, true]) {
	try {
		console.log("tdz", early, readEarly(early));
	} catch (error) {
		gc();
		console.log("tdz", early, error instanceof ReferenceError);
	}
}

globalThis.retryStorage = (read, held) => {
	for (;;) {
		try {
			return read(held);
		} catch (error) {
			gc();
			if (error !== held) throw error;
		}
	}
};
let attempts = 0;
const retryValue = globalThis.makeStorageValue(17);
console.log(
	"retry",
	globalThis.retryStorage((value) => {
		if (++attempts < 4) throw value;
		return value.value + value.padding.length;
	}, retryValue),
	attempts,
);

globalThis.scalarStorage = (left, right, one) => {
	const a = +left;
	const b = +right;
	const subtract = +one;
	return a * b - subtract;
};
const rounding = globalThis.scalarStorage(1 + 2 ** -27, 1 - 2 ** -27, 1);
console.log("rounding", Object.is(rounding, 0));
console.log("negative-zero", Object.is(globalThis.scalarStorage(-0, 2, 0), -0));
console.log("nan", Number.isNaN(globalThis.scalarStorage(0, Infinity, 0)));
console.log("infinity", globalThis.scalarStorage(Infinity, 2, 1));
const coercions = [];
const scalarInput = (value, label) => ({
	valueOf() {
		coercions.push(label);
		return value;
	},
});
console.log(
	"coercions",
	globalThis.scalarStorage(scalarInput(3, "a"), scalarInput(4, "b"), scalarInput(1, "c")),
	coercions.join(""),
);

const scalarCallEffects = [];
globalThis.recordScalarCall = (value, index) => {
	gc();
	scalarCallEffects.push(`${value}:${index}`);
};
function observeScalar(value) {
	for (let index = 0; index < 2; index++) globalThis.recordScalarCall(value, index);
}
globalThis.scalarWithCalls = (left, right, one) => {
	const a = +left;
	const b = +right;
	const subtract = +one;
	observeScalar(a);
	const product = a * b;
	const difference = product - subtract;
	observeScalar(difference);
	return difference;
};
console.log(
	"scalar-calls",
	globalThis.scalarWithCalls(3, 4, 1),
	scalarCallEffects.join(","),
);

function scalarLeaf(condition, left, right) {
	if (condition) return left * right - 1;
	return left / right + 1;
}
function scalarSort(left, right) {
	if (left < right) return (left - right) * 0.5;
	return (left - right) * 0.25;
}
function sortScalarInput(values) {
	return values.sort(scalarSort);
}
console.log("scalar-sort", sortScalarInput([12, 3, 8, -5]).join(","));
globalThis.scalarLeaf = scalarLeaf;
const leafResults = [];
for (let index = 0; index < 3; index++) {
	leafResults.push(scalarLeaf(index > 0, index + 3, 4));
	gc();
}
console.log("scalar-leaf", leafResults.join(","));
console.log("leaf-rounding", Object.is(scalarLeaf(true, 1 + 2 ** -27, 1 - 2 ** -27), 0));

const constantEffects = [];
globalThis.observeConstants = (mask, offset) => {
	gc();
	constantEffects.push(`${mask}:${offset}`);
};
globalThis.scalarConstants = (input, condition) => {
	const mask = 17;
	const offset = 1.25;
	globalThis.observeConstants(mask, offset);
	if (condition) return ((+input & mask) + mask) * offset;
	return (+input + mask) / offset;
};
console.log(
	"scalar-constants",
	globalThis.scalarConstants(31, true),
	globalThis.scalarConstants(31, false),
	constantEffects.join(","),
);
function scalarRegionTail(left, right, other) {
	const product = left * right;
	globalThis.observeConstants(product - 1, other);
	return -(other * other);
}
const tailResults = [];
for (let index = 0; index < 3; index++) {
	tailResults.push(scalarRegionTail(index + 1, 4, 5));
}
console.log("region-tail", tailResults.join(","));

function scheduledRegion(value, choose, left, right, observe) {
	const fused = value.a + value.b * 2;
	let result;
	if (choose) {
		observe("left", left);
		result = left;
	} else {
		observe("right", right);
		result = right;
	}
	try {
		observe("join", result);
	} catch (error) {
		observe("catch", result);
	}
	return fused + result.value;
}
globalThis.scheduledRegion = scheduledRegion;
for (const choose of [false, true])
	for (const fail of [false, true]) {
		const events = [];
		const value = {
			get a() {
				events.push("a");
				gc();
				return 3;
			},
			get b() {
				events.push("b");
				gc();
				return 7;
			},
		};
		const observe = (stage, selected) => {
			gc();
			events.push(stage + ":" + selected.value);
			if (fail && stage === "join") throw new Error("scheduled-join");
		};
		console.log(
			"scheduled-region",
			choose,
			fail,
			scheduledRegion(
				value,
				choose,
				globalThis.makeStorageValue(2),
				globalThis.makeStorageValue(9),
				observe,
			),
			events.join(","),
		);
	}

function scalarWithRegion(value, left, right, observe) {
	const fused = value.a + value.b * 2;
	observe(fused);
	const a = +left;
	const b = +right;
	const difference = a - b;
	return difference < a;
}
function scalarWithHandler(left, observe) {
	let result;
	try {
		const protectedValue = +left;
		result = observe(protectedValue);
	} catch (error) {
		result = observe(error);
	}
	const a = +left;
	const b = +result;
	const difference = a - b;
	return difference < a;
}
globalThis.scalarWithRegion = scalarWithRegion;
globalThis.scalarWithHandler = scalarWithHandler;
for (const value of [-0, 7, Infinity, NaN]) {
	const label = Object.is(value, -0) ? "-0" : String(value);
	for (const fail of [false, true]) {
		let called = false;
		const observe = (input) => {
			gc();
			if (fail && !called) {
				called = true;
				throw input;
			}
			return input;
		};
		console.log("handler-scalars", label, fail, scalarWithHandler(value, observe));
	}
	console.log(
		"region-scalars",
		label,
		scalarWithRegion(
			{
				get a() {
					gc();
					return 3;
				},
				get b() {
					gc();
					return 5;
				},
			},
			value,
			2,
			gc,
		),
	);
}
globalThis.scalarConstantZero = (condition) => {
	const value = -0;
	gc();
	if (condition) return value * 2;
	return value / 2;
};
console.log(
	"constant-zero",
	Object.is(globalThis.scalarConstantZero(true), -0),
	Object.is(globalThis.scalarConstantZero(false), -0),
);

globalThis.shiftStorage = (values, selected) => {
	values.pop();
	for (let index = values.length; index > selected; index--) {
		values[index] = values[index - 1];
	}
	return values.join(",");
};
console.log("reverse", globalThis.shiftStorage([5, 7, 11, 13], 1));

globalThis.splitStorage = (value, separator) => {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		total += parts[index].trim().length;
	}
	return total;
};
console.log("split", globalThis.splitStorage("a |bc| def ", "|"));

globalThis.sumRegexStorage = (value, regexp) => {
	let sum = 0;
	for (const match of value.matchAll(regexp)) {
		sum += Number(match[1]);
		if (sum > 10) break;
	}
	return sum;
};
console.log("regexp-exit", globalThis.sumRegexStorage("3,4,8,99", /(\d+)/g));
console.log("regexp-exhausted", globalThis.sumRegexStorage("3,4", /(\d+)/g));
console.log("regexp-empty", globalThis.sumRegexStorage("", /(\d+)/g));

function postProperty(value) {
	return value.count++;
}
function preProperty(value) {
	return --value.count;
}
function addProperty(value, delta) {
	return (value.count += delta);
}
function copyProperty(value, delta) {
	return (value.other = delta - value.count);
}
globalThis.postProperty = postProperty;
globalThis.preProperty = preProperty;
globalThis.addProperty = addProperty;
globalThis.copyProperty = copyProperty;
const updateNumber = (value) => (Object.is(value, -0) ? "-0" : String(value));
for (const initial of [2, -0, 2147483647, NaN, Infinity, -Infinity, "4", 7n]) {
	const value = { count: initial, other: 0 };
	for (let i = 0; i < 3; i++) {
		console.log(
			"property-update",
			updateNumber(postProperty(value)),
			updateNumber(preProperty(value)),
			updateNumber(value.count),
		);
		gc();
	}
}
const updateOrder = [];
let updateHeld = 11;
const updateAccessor = {
	get count() {
		updateOrder.push("get");
		gc();
		return updateHeld;
	},
	set count(value) {
		updateOrder.push(`set:${value}`);
		gc();
		updateHeld = value;
	},
};
console.log("update-accessor", postProperty(updateAccessor), preProperty(updateAccessor));
const updateProxy = new Proxy(
	{ count: 17 },
	{
		get(target, key) {
			updateOrder.push(`proxy-get:${key}`);
			gc();
			return target[key];
		},
		set(target, key, value) {
			updateOrder.push(`proxy-set:${key}:${value}`);
			gc();
			target[key] = value;
			return true;
		},
	},
);
console.log("update-proxy", addProperty(updateProxy, 3));
const updateCoercion = {
	count: {
		valueOf() {
			updateOrder.push("coerce");
			gc();
			updateCoercion.count = 100;
			return 5;
		},
	},
};
console.log("update-coercion", postProperty(updateCoercion), updateCoercion.count);
console.log(
	"update-rhs",
	addProperty(
		{ count: 3 },
		{
			valueOf() {
				updateOrder.push("rhs");
				gc();
				return 9;
			},
		},
	),
);
console.log("update-string", addProperty({ count: "3" }, 4));
console.log("update-bigint", String(addProperty({ count: 3n }, 4n)));
const updatePair = { count: 5, other: 1 };
for (let i = 0; i < 3; i++)
	console.log(
		"update-copy",
		copyProperty(updatePair, 20),
		updatePair.count,
		updatePair.other,
	);
function strictProperty(value) {
	"use strict";
	return ++value.count;
}
for (const value of [
	Object.freeze({ count: 9 }),
	{
		get count() {
			updateOrder.push("throw-get");
			gc();
			throw new Error("update-getter");
		},
	},
	{
		get count() {
			return 9;
		},
		set count(value) {
			gc();
			throw new Error(`update-setter:${value}`);
		},
	},
]) {
	try {
		console.log("update-strict", strictProperty(value));
	} catch (error) {
		console.log("update-error", error instanceof TypeError ? "TypeError" : error.message);
	}
}
const warmedUpdate = { count: 10 };
for (let index = 0; index < 5; index++) strictProperty(warmedUpdate);
Object.freeze(warmedUpdate);
try {
	strictProperty(warmedUpdate);
} catch (error) {
	console.log("update-frozen-cache", error instanceof TypeError, warmedUpdate.count);
}
try {
	addProperty({ count: 3n }, 4);
} catch (error) {
	console.log("update-mixed", error instanceof TypeError);
}
try {
	postProperty({
		count: {
			valueOf() {
				gc();
				throw new Error("update-coercion-throw");
			},
		},
	});
} catch (error) {
	console.log("update-coercion-error", error.message);
}
console.log("update-order", updateOrder.join(":"));

function* wideHolder() {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(99);
	try {
		yield "ready";
		yield held.value;
	} finally {
		console.log("finally", held.value, held.padding.length);
	}
}

async function wideAsync(gate) {
	globalThis.makeStorageValue(1);
	globalThis.makeStorageValue(2);
	globalThis.makeStorageValue(3);
	globalThis.makeStorageValue(4);
	globalThis.makeStorageValue(5);
	globalThis.makeStorageValue(6);
	globalThis.makeStorageValue(7);
	globalThis.makeStorageValue(8);
	const held = globalThis.makeStorageValue(77);
	try {
		await gate;
	} catch (error) {
		console.log("await-constructor", error.kind, held.value, held.padding.length);
		throw error;
	}
	return held.value + held.padding.length;
}

const suspended = wideHolder();
console.log(suspended.next().value);
gc();
console.log(suspended.next().value);
gc();
try {
	suspended.throw(new Error("resume-throw"));
} catch (error) {
	console.log(error.message);
}
gc();
console.log(suspended.next().done);

let openGate;
const gate = new Promise((resolve) => (openGate = resolve));
wideAsync(gate).then((value) => console.log("async", value));
const invalidAwait = Promise.resolve(1);
Object.defineProperty(invalidAwait, "constructor", {
	get() {
		gc();
		throw { kind: "throwing-getter" };
	},
});
wideAsync(invalidAwait).then(
	() => console.log("unexpected-await-success"),
	(error) => console.log("await-rejected", error.kind),
);
setTimeout(() => {
	gc();
	openGate();
}, 0);

function* consumedResumes() {
	for (let index = 0; index < 2; index++) {
		const value = yield index;
		globalThis.consumeResumeValue(value);
	}
	return "released";
}
globalThis.consumeResumeValue = (value) => {
	globalThis.resumeReference = new WeakRef(value);
};
globalThis.suspendedResumeIterator = consumedResumes();
globalThis.suspendedResumeIterator.next();
function sendResumeValue() {
	globalThis.suspendedResumeIterator.next({ value: 123 });
}
sendResumeValue();
setTimeout(() => {
	gc();
	if (
		typeof globalThis.__mal_collect_garbage === "function" &&
		globalThis.resumeReference.deref() !== undefined
	)
		throw new Error("Suspended resume output retained its previous input");
	globalThis.consumeResumeValue = () => {};
	console.log("resume-output", globalThis.suspendedResumeIterator.next().value);
}, 0);

async function consumedAwaits() {
	for (let index = 0; index < 2; index++) {
		const value = await globalThis.awaitGates[index];
		globalThis.consumeAwaitValue(value);
	}
	return "released";
}
globalThis.consumeAwaitValue = (value) => {
	globalThis.awaitReference = new WeakRef(value);
};
globalThis.awaitGates = [
	new Promise((resolve) => (globalThis.sendFirstAwaitValue = resolve)),
	new Promise((resolve) => (globalThis.sendSecondAwaitValue = resolve)),
];
globalThis.suspendedAwaitResult = consumedAwaits();
globalThis.sendFirstAwaitValue({ value: 456 });
globalThis.sendFirstAwaitValue = undefined;
setTimeout(() => {
	globalThis.awaitGates[0] = undefined;
	gc();
	if (
		typeof globalThis.__mal_collect_garbage === "function" &&
		globalThis.awaitReference.deref() !== undefined
	)
		throw new Error("Suspended await output retained its previous input");
	globalThis.consumeAwaitValue = () => {};
	globalThis.sendSecondAwaitValue();
	globalThis.sendSecondAwaitValue = undefined;
	globalThis.suspendedAwaitResult.then((value) => console.log("await-output", value));
}, 0);

function boxedReadPair(receiver) {
	const left = receiver.left;
	const right = receiver.right;
	return [left, right];
}
const boxedPairReceiver = { left: { label: "left" }, right: { label: "right" } };
for (let index = 0; index < 8; index++) boxedReadPair(boxedPairReceiver);
console.log(
	"boxed-pair",
	boxedReadPair(boxedPairReceiver)
		.map((value) => value.label)
		.join(":"),
);
const pairOrder = [];
const getterPair = {
	get left() {
		pairOrder.push("left");
		gc();
		this.right = { label: "changed" };
		return { label: "getter" };
	},
	right: { label: "old" },
};
console.log(
	"boxed-getter",
	boxedReadPair(getterPair)
		.map((value) => value.label)
		.join(":"),
);
const proxyPair = new Proxy(boxedPairReceiver, {
	get(target, key) {
		pairOrder.push(key);
		gc();
		return target[key];
	},
});
console.log(
	"boxed-proxy",
	boxedReadPair(proxyPair)
		.map((value) => value.label)
		.join(":"),
	pairOrder.join(":"),
);

async function compactScalarAsync(input, gate) {
	const value = +input;
	const before = value * 1;
	const flag = before < 0;
	const integer = input | 0;
	try {
		await gate;
		return [before, flag, Object.is(before, -0), integer];
	} finally {
		gc();
	}
}
Promise.all(
	[-0, NaN, Infinity, -4.5, 2147483648].map((value) =>
		compactScalarAsync(value, Promise.resolve()),
	),
).then((values) => {
	console.log(
		"compact-numbers",
		values
			.map((value) => `${String(value[0])}:${value[1]}:${value[2]}:${value[3]}`)
			.join("|"),
	);
});

function* compactScalarSequence(seed) {
	let value = +seed;
	let flag = true;
	try {
		for (let index = 0; index < 3; index++) {
			value = value * 1.5 + index;
			flag = !flag;
			yield [value, flag];
		}
	} finally {
		console.log("compact-finally", value, flag);
	}
	return value;
}
const compactSequence = compactScalarSequence(2);
console.log("compact-yield", JSON.stringify(compactSequence.next()));
gc();
console.log("compact-yield", JSON.stringify(compactSequence.next()));
gc();
console.log("compact-return", JSON.stringify(compactSequence.return("closed")));

async function* compactAsyncSequence(seed) {
	const before = +seed * 3.25;
	try {
		yield before;
		yield before + 1;
	} finally {
		gc();
	}
}
const compactAsyncIterator = compactAsyncSequence(4);
Promise.all([
	compactAsyncIterator.next(),
	compactAsyncIterator.next(),
	compactAsyncIterator.return("closed"),
]).then((values) => console.log("compact-async-yields", JSON.stringify(values)));

async function compactSpillNumber(input, gate) {
	const value = +input;
	const square = value * value;
	const before = square + 1;
	await gate;
	return before + 2;
}
async function compactSpillInteger(input, gate) {
	const integer = input < 0 ? 17 : 18;
	await gate;
	return integer + input;
}
async function compactSpillBoolean(input, gate) {
	const flag = input < 0;
	await gate;
	return !flag;
}

async function compactPhases(gate, left, right) {
	const first = +left;
	await gate;
	gc();
	globalThis.compactPhaseFirst = first;
	const second = +right;
	await gate;
	gc();
	return second;
}
compactPhases(Promise.resolve(), -0, NaN).then((value) =>
	console.log(
		"compact-phases",
		Object.is(globalThis.compactPhaseFirst, -0),
		String(value),
	),
);
Promise.all([
	compactSpillNumber(-4.5, Promise.resolve()),
	compactSpillNumber(NaN, Promise.resolve()),
	compactSpillNumber(Infinity, Promise.resolve()),
	compactSpillInteger(-20, Promise.resolve()),
	compactSpillBoolean(-4.5, Promise.resolve()),
	compactSpillBoolean(-0, Promise.resolve()),
]).then((values) => console.log("compact-spills", values.map(String).join(":")));

function* retainOccupant(value) {
	const object = { value };
	globalThis.occupantReference = new WeakRef(value);
	yield "parked";
	object.value = 0;
	return 1;
}
globalThis.occupantIterator = retainOccupant({ value: 789 });
globalThis.occupantIterator.next();
setTimeout(() => {
	gc();
	if (globalThis.occupantReference.deref() === undefined)
		throw new Error("Suspension lost a scalar-replaced object's boxed occupant");
	console.log("compact-occupant", globalThis.occupantIterator.next().value);
}, 0);

function typedStackFields(input) {
	const object = { fraction: -0, integer: 2, flag: true };
	gc();
	if (input) {
		object.fraction = 0 / 0;
		object.integer = 3;
		object.flag = false;
	} else {
		object.fraction = -0;
		object.integer = 4;
		object.flag = true;
	}
	gc();
	return object === input
		? "identity"
		: [
				String(object.fraction),
				Object.is(object.fraction, -0),
				object.integer,
				object.flag,
			].join(":");
}
function typedStackNaN(input) {
	const object = { fraction: 0 / 0, integer: -2147483648, flag: false };
	gc();
	return object === input
		? "identity"
		: [String(object.fraction), object.integer, object.flag].join(":");
}
console.log(
	"typed-stack-fields",
	typedStackFields(null),
	typedStackFields(true),
	typedStackNaN(null),
);

globalThis.makeMixedValue = (marker) => ({
	marker,
	padding: new Array(300).fill(marker),
});
globalThis.makeMixedString = (marker) => `value-${marker}-${"x".repeat(80)}`;
function mixedStackFields(input) {
	const object = {
		fraction: -0,
		integer: 2,
		flag: true,
		payload: globalThis.makeMixedValue(11),
		label: globalThis.makeMixedString(13),
	};
	gc();
	if (input) {
		object.fraction = 0 / 0;
		object.integer = 3;
		object.flag = false;
		object.payload = globalThis.makeMixedValue(17);
		object.label = globalThis.makeMixedString(19);
	} else {
		object.fraction = -0;
		object.integer = 4;
		object.flag = true;
		object.payload = globalThis.makeMixedValue(23);
		object.label = globalThis.makeMixedString(29);
	}
	gc();
	return object === input
		? "identity"
		: [
				String(object.fraction),
				Object.is(object.fraction, -0),
				object.integer,
				object.flag,
				object.payload.marker,
				object.payload.padding.length,
				object.label,
				object.label.length,
			].join(":");
}
globalThis.mixedStackFields = mixedStackFields;
console.log("mixed-stack-fields", mixedStackFields(null), mixedStackFields(true));

function typedReturnedFields(escape, fail) {
	const object = {
		fraction: -0,
		integer: 2,
		flag: true,
		payload: globalThis.makeMixedValue(41),
		label: globalThis.makeMixedString(43),
	};
	gc();
	if (escape) {
		object.fraction = 0 / 0;
		object.integer = 3;
		object.flag = false;
		object.payload = globalThis.makeMixedValue(47);
		object.label = globalThis.makeMixedString(53);
	}
	gc();
	if (fail) globalThis.__mal_fail_next_cell_allocation();
	if (escape) return object;
	return 0;
}
globalThis.typedReturnedFields = typedReturnedFields;
const returnedFields = typedReturnedFields(true, false);
const returnedAgain = typedReturnedFields(true, false);
gc();
console.log(
	"typed-return-fields",
	Number.isNaN(returnedFields.fraction),
	returnedFields.integer,
	returnedFields.flag,
	returnedFields.payload.marker,
	returnedFields.label.length,
	Object.getPrototypeOf(returnedFields) === Object.prototype,
	returnedFields !== returnedAgain,
	typedReturnedFields(false, false),
);
returnedFields.integer = 71;
if (returnedAgain.integer !== 3)
	throw new Error("materialized objects share field storage");
if (typeof globalThis.__mal_fail_next_cell_allocation === "function") {
	let caught = false;
	try {
		typedReturnedFields(true, true);
	} catch (error) {
		caught = error instanceof Error;
	}
	if (!caught) throw new Error("typed materialization failure was not catchable");
}

function shapeBranches(flag, input) {
	let total = 0;
	let object;
	if (flag) {
		object = { left: input };
		globalThis.leftShape = object;
		total = object.left;
		if (input) {
			object = { inner: input };
			globalThis.innerShape = object;
			total += object.inner;
		}
	} else {
		object = { right: input };
		globalThis.rightShape = object;
		total = object.right;
	}
	const tail = { after: input };
	globalThis.afterShape = tail;
	return total + tail.after;
}
globalThis.shapeBranches = shapeBranches;
console.log(
	"shape-branches",
	shapeBranches(false, 3),
	shapeBranches(true, 0),
	shapeBranches(true, 5),
);
