const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
function conditionalKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "field";
	return { [key]: value };
}
function conditionalProtoKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "__proto__";
	return { [key]: value };
}
function liveInitializer(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "field";
	return { [key]: observe(value) };
}
function conditionalSymbolKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : Symbol.for("stable-key");
	return { [key]: value };
}
globalThis.computedKey = conditionalKey;
globalThis.computedProtoKey = conditionalProtoKey;
globalThis.computedLive = liveInitializer;
globalThis.computedSymbolKey = conditionalSymbolKey;
function requireSymbol(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const base = flag !== flag ? value : Symbol.for("coercible");
	const {} = base;
	return base;
}
function checkCoercible(value) {
	const {} = value;
	return 7;
}
const primitivePropertyReceiver = function primitivePropertyReceiver(flag, observe) {
	const suffix = observe(new.target);
	return flag ? "A𝌆" + suffix + "Z" : 42;
};
function namedPrimitiveWrite(flag, makeValue, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return (receiver.__mal_receiver_probe = makeValue());
}
function indexedPrimitiveRead(flag, key, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return receiver[key];
}
function primitiveMembership(flag, key, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return key in receiver;
}
function primitivePropertyPair(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	const a = receiver.__mal_receiver_probe;
	const b = receiver.__mal_receiver_probe;
	return [a, b];
}
function primitivePropertyRegion(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	const a = receiver.__mal_receiver_probe;
	const b = receiver.__mal_receiver_probe;
	const c = receiver.__mal_receiver_probe;
	return [a, b, c];
}
function primitivePropertyProjection(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return receiver.__mal_receiver_probe + receiver.__mal_receiver_probe;
}
function primitiveNumberRecord(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return (
		receiver.__mal_receiver_probe +
		receiver.__mal_receiver_probe +
		receiver.__mal_receiver_probe +
		receiver.__mal_receiver_probe +
		receiver.__mal_receiver_probe
	);
}
function primitiveNumericUpdate(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return receiver.__mal_receiver_numeric++;
}
function primitiveArrayPresence(flag, expected, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	for (let i = 0; i < receiver.length; i++) {
		observe(i);
		if (i in receiver) {
			const same = receiver[i] === expected[i];
			if (!same) return false;
		}
	}
	return true;
}
function primitivePairedPrimary(flag, expected, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	for (let i = 0; i < receiver.length; i++) {
		observe(i);
		const same = receiver[i] === expected[i];
		if (!same) return false;
	}
	return true;
}
function primitivePairedSecondary(flag, expected, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	for (let i = 0; i < expected.length; i++) {
		observe(i);
		const same = expected[i] === receiver[i];
		if (!same) return false;
	}
	return true;
}
function primitiveArrayDestructure(flag, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	const [first, second] = receiver;
	return [first, second];
}
function indexedPrimitiveWrite(flag, key, makeValue, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	return (receiver[key] = makeValue());
}
function* suspendedPrimitiveWrite(flag, key, makeValue, observe) {
	const receiver = primitivePropertyReceiver(flag, observe);
	yield receiver;
	return (receiver[key] = makeValue());
}
Object.assign(globalThis, {
	namedPrimitiveWrite,
	indexedPrimitiveRead,
	primitiveMembership,
	primitivePropertyPair,
	primitivePropertyRegion,
	primitivePropertyProjection,
	primitiveNumberRecord,
	primitiveNumericUpdate,
	primitiveArrayPresence,
	primitivePairedPrimary,
	primitivePairedSecondary,
	primitiveArrayDestructure,
	indexedPrimitiveWrite,
	suspendedPrimitiveWrite,
});
const nullableLengthSource = function nullableLengthSource(flag, observe) {
	observe(new.target);
	return flag === undefined ? undefined : flag ? "A𝌆Z" + observe("") : null;
};
function nullableStringLength(flag, observe) {
	const text = nullableLengthSource(flag, observe);
	observe(text);
	return text.length * 2;
}
function nullableLengthObservation(flag, observe) {
	const text = nullableLengthSource(flag, observe);
	observe(text);
	return typeof text.length === "number";
}
function nullableLengthPredicates(flag, observe) {
	const text = nullableLengthSource(flag, observe);
	observe(text);
	const n = text.length;
	return [
		Number.isNaN(n),
		Number.isFinite(n),
		Number.isInteger(n),
		Number.isSafeInteger(n),
		n < 0,
		Math.abs(n),
	];
}
function privateArrayLengthPredicates(value, observe) {
	const values = [];
	let ok = true;
	for (let i = 0; i < (value | 0); i++) {
		values[i] = i;
		observe(i);
		ok = ok && Number.isSafeInteger(values.length);
	}
	return ok;
}
function objectLengthPredicates(value, observe) {
	observe(value);
	const n = value.length;
	return [
		Number.isNaN(n),
		Number.isFinite(n),
		Number.isInteger(n),
		Number.isSafeInteger(n),
		n < 0,
		Math.abs(n),
	];
}
function lengthPredicateOrder(value) {
	const text = value === null ? null : value + ":";
	return Number.isInteger(text.length);
}
function nullableLengthForward(flag, observe) {
	return nullableStringLength(flag, observe);
}
function* nullableSuspendedLength(flag, observe) {
	const text = nullableLengthSource(flag, observe);
	yield observe(text);
	return text.length * 2;
}
const mixedLengthSource = function mixedLengthSource(flag, observe) {
	observe(new.target);
	return flag ? "fixed" : observe();
};
function mixedStringLength(flag, observe) {
	return mixedLengthSource(flag, observe).length;
}
Object.assign(globalThis, {
	nullableStringLength,
	nullableLengthForward,
	nullableLengthObservation,
	nullableLengthPredicates,
	privateArrayLengthPredicates,
	objectLengthPredicates,
	lengthPredicateOrder,
	nullableSuspendedLength,
	mixedStringLength,
});
function branchStringLength(value) {
	if (typeof value === "string") return value.length;
	return -1;
}
function branchStringJoin(value, observe) {
	let text = "fallback";
	if (typeof value === "string") text = value;
	observe(text);
	return text.length;
}
function* branchSuspendedLength(value, observe) {
	if (typeof value !== "string") return -1;
	yield observe(value);
	return value.length;
}
function branchCoercible(value, observe) {
	if (value) {
		observe(value);
		const {} = value;
		return 7;
	}
	return -1;
}
function branchObservation(value, observe) {
	if (typeof value === "string") {
		observe(value);
		return typeof value === "object";
	}
	return true;
}
function branchObjectProperty(value, observe) {
	if (typeof value === "object" && value !== null) {
		observe(value);
		return value.length;
	}
	return -1;
}
function branchSymbolProperty(value, key, observe) {
	if (typeof key !== "symbol") return -1;
	observe(key);
	return value[key];
}
Object.assign(globalThis, {
	branchStringLength,
	branchStringJoin,
	branchSuspendedLength,
	branchObjectProperty,
	branchSymbolProperty,
	branchCoercible,
	branchObservation,
});
globalThis.requireSymbol = requireSymbol;
globalThis.checkCoercible = checkCoercible;
const rows = [];
for (let round = 0; round < 8; round++) {
	let order = "";
	const value = { round, parts: [round, "retained"] };
	const symbol = Symbol("dynamic");
	const key = {
		[Symbol.toPrimitive](hint) {
			order += hint;
			collectGarbage?.();
			return round % 2 === 0 ? symbol : "dynamic";
		},
	};
	function observe(input) {
		order += typeof input === "number" ? input : typeof input === "string" ? input : "v";
		collectGarbage?.();
		return input === "key" ? key : input;
	}
	globalThis.keyObserver = observe;
	const plain = conditionalKey("string", value, globalThis.keyObserver);
	const proto = conditionalProtoKey("string", value, globalThis.keyObserver);
	const live = liveInitializer("string", value, globalThis.keyObserver);
	collectGarbage?.();
	for (const object of [plain, live]) {
		const descriptor = Object.getOwnPropertyDescriptor(object, "field");
		if (
			object.field !== value ||
			object.field.parts[0] !== round ||
			!descriptor.enumerable ||
			!descriptor.configurable ||
			!descriptor.writable
		)
			throw new Error("literal key definition");
	}
	if (
		!Object.hasOwn(proto, "__proto__") ||
		proto.__proto__ !== value ||
		Object.getPrototypeOf(proto) !== Object.prototype ||
		order !== "010101v"
	)
		throw new Error("computed prototype key or initializer order");
	rows.push(order);
	order = "";
	const dynamic = conditionalKey(NaN, value, globalThis.keyObserver);
	collectGarbage?.();
	const property = round % 2 === 0 ? symbol : "dynamic";
	if (
		!Object.hasOwn(dynamic, property) ||
		dynamic[property] !== value ||
		order !== "01keystring"
	)
		throw new Error("dynamic property coercion");
	rows.push(order);
	order = "";
	const dynamicProto = conditionalProtoKey(NaN, value, globalThis.keyObserver);
	const dynamicLive = liveInitializer(NaN, value, globalThis.keyObserver);
	if (
		dynamicProto[property] !== value ||
		dynamicLive[property] !== value ||
		order !== "01keystring01keystringv"
	)
		throw new Error("dynamic prototype key or initializer order");
	order = "";
	const symbolResult = conditionalSymbolKey("string", value, globalThis.keyObserver);
	const dynamicSymbol = conditionalSymbolKey(NaN, value, globalThis.keyObserver);
	collectGarbage?.();
	if (
		symbolResult[Symbol.for("stable-key")] !== value ||
		dynamicSymbol[property] !== value ||
		order !== "0101keystring"
	)
		throw new Error("boxed Symbol key or dynamic fallback");
	order = "";
	if (
		requireSymbol("string", null, globalThis.keyObserver) !== Symbol.for("coercible") ||
		order !== "01"
	)
		throw new Error("proven coercible Symbol");
	try {
		requireSymbol(NaN, null, globalThis.keyObserver);
		throw new Error("missing canonical coercibility exception");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
}
for (const value of [
	0,
	false,
	"",
	123n,
	Symbol("coercible"),
	{},
	{
		[Symbol.toPrimitive]() {
			throw new Error("unexpected coercion");
		},
	},
])
	if (globalThis.checkCoercible(value) !== 7)
		throw new Error("frameless coercible value");
for (const value of [null, undefined]) {
	try {
		globalThis.checkCoercible(value);
		throw new Error("missing frameless coercibility exception");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
}
for (const value of [undefined, null, 123n, Symbol("value"), "𝌆", -0]) {
	const result = globalThis.computedKey("string", value, () => collectGarbage?.());
	collectGarbage?.();
	if (!Object.is(result.field, value)) throw new Error("mixed property value");
}
let order = "";
const thrown = { thrown: true };
const badKey = {
	[Symbol.toPrimitive]() {
		order += "coerce";
		collectGarbage?.();
		throw thrown;
	},
};
try {
	conditionalKey(NaN, null, (value) => {
		order += value;
		return badKey;
	});
	throw new Error("missing property coercion exception");
} catch (caught) {
	if (caught !== thrown || order !== "01keycoerce")
		throw new Error("property coercion exception order");
}
order = "";
try {
	liveInitializer("string", "throw", (value) => {
		order += value;
		collectGarbage?.();
		if (value === "throw") throw thrown;
		return value;
	});
	throw new Error("missing property initializer exception");
} catch (caught) {
	if (caught !== thrown || order !== "01throw")
		throw new Error("property initializer exception order");
}
let inheritedWrites = 0;
const mutable = process.env.MAL_PRIMORDIALS !== "locked";
if (mutable)
	Object.defineProperty(Object.prototype, "field", {
		configurable: true,
		set() {
			inheritedWrites++;
		},
	});
try {
	const result = conditionalKey("string", "value", () => collectGarbage?.());
	if (result.field !== "value" || !Object.hasOwn(result, "field"))
		throw new Error("inherited property setter intercepted definition");
} finally {
	if (mutable) delete Object.prototype.field;
}
if (inheritedWrites !== 0) throw new Error("inherited property setter ran");
if (mutable) {
	const original = Symbol.for;
	Symbol.for = () => "replaced";
	try {
		const result = conditionalSymbolKey("string", "value", () => collectGarbage?.());
		if (result.replaced !== "value") throw new Error("replaced Symbol producer fallback");
		Symbol.for = () => null;
		try {
			requireSymbol("string", null, () => collectGarbage?.());
			throw new Error("missing replaced coercible producer exception");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
	} finally {
		Symbol.for = original;
	}
}
const propertyEvents = [];
let propertyTick = 0;
let receivedValue;
let throwAccessor = false;
function observeProperty() {
	collectGarbage?.();
	return ++propertyTick;
}
function makePropertyValue() {
	propertyEvents.push("rhs");
	collectGarbage?.();
	return { keep: [++propertyTick, "retained"] };
}
function getPrimitiveProperty() {
	propertyEvents.push(`get:${typeof this}`);
	collectGarbage?.();
	if (throwAccessor) throw thrown;
	return this;
}
function setPrimitiveProperty(value) {
	propertyEvents.push(`set:${typeof this}`);
	collectGarbage?.();
	if (throwAccessor) throw thrown;
	if (typeof this !== "number" || this !== 42 || value.keep[1] !== "retained")
		throw new Error("primitive setter receiver or value root");
	receivedValue = value;
}
function setPrimitiveNumericProperty(value) {
	propertyEvents.push(`numeric:${typeof this}:${value}`);
	collectGarbage?.();
	if (typeof this !== "number" || this !== 42 || value !== 43)
		throw new Error("primitive numeric update receiver or value");
}
function primitiveIterator() {
	if (this !== 42) throw new Error("primitive iterator receiver");
	collectGarbage?.();
	const iterator = [makePropertyValue(), "second", "unused"].values();
	iterator.return = function () {
		propertyEvents.push("iterator:return");
		collectGarbage?.();
		return {};
	};
	return iterator;
}
function getPrimitiveIterator() {
	propertyEvents.push("iterator:get");
	collectGarbage?.();
	if (throwAccessor) throw thrown;
	return primitiveIterator;
}
const receiverKey = Symbol("primitive receiver key");
const installations = [
	[
		Number.prototype,
		"__mal_receiver_probe",
		{ get: getPrimitiveProperty, set: setPrimitiveProperty },
	],
	[Number.prototype, "0", { get: getPrimitiveProperty, set: setPrimitiveProperty }],
	[
		Number.prototype,
		receiverKey,
		{ get: getPrimitiveProperty, set: setPrimitiveProperty },
	],
	[String.prototype, "__mal_receiver_probe", { get: getPrimitiveProperty }],
	[
		Number.prototype,
		"__mal_receiver_numeric",
		{ get: getPrimitiveProperty, set: setPrimitiveNumericProperty },
	],
	[String.prototype, "__mal_receiver_numeric", { get: getPrimitiveProperty }],
	[
		Number.prototype,
		"length",
		{
			get() {
				collectGarbage?.();
				return 2;
			},
		},
	],
	[Number.prototype, Symbol.iterator, { get: getPrimitiveIterator }],
];
if (mutable)
	for (const [prototype, key, descriptor] of installations)
		Object.defineProperty(prototype, key, { configurable: true, ...descriptor });
try {
	for (const flag of [false, true]) {
		propertyEvents.length = 0;
		const indexed = globalThis.indexedPrimitiveRead(flag, 0, observeProperty);
		if (indexed !== (flag ? "A" : mutable ? 42 : undefined))
			throw new Error("primitive indexed read");
		if (flag && globalThis.indexedPrimitiveRead(flag, 1, observeProperty) !== "\ud834")
			throw new Error("primitive UTF-16 index");
		const coercingKey = {
			[Symbol.toPrimitive](hint) {
				propertyEvents.push(`key:${hint}`);
				collectGarbage?.();
				return receiverKey;
			},
		};
		for (const key of [0, receiverKey, coercingKey]) {
			const eventCount = propertyEvents.length;
			try {
				globalThis.primitiveMembership(flag, key, observeProperty);
				throw new Error("missing primitive membership error");
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				if (propertyEvents.length !== eventCount)
					throw new Error("primitive membership coerced its key");
				propertyEvents.push("in:TypeError");
			}
		}
		for (const read of [
			globalThis.primitivePropertyPair,
			globalThis.primitivePropertyRegion,
		]) {
			const values = read(flag, observeProperty);
			collectGarbage?.();
			if (
				!values.every((value) => value === values[0]) ||
				typeof values[0] !== (mutable ? (flag ? "string" : "number") : "undefined")
			)
				throw new Error("primitive grouped property reads");
			rows.push(values);
		}
		rows.push(globalThis.primitivePropertyProjection(flag, observeProperty));
		rows.push(globalThis.primitiveNumberRecord(flag, observeProperty));
		const expected = ["A", "\ud834", "\udf06"];
		rows.push(globalThis.primitivePairedPrimary(flag, expected, observeProperty));
		rows.push(globalThis.primitivePairedSecondary(flag, expected, observeProperty));
		try {
			const result = globalThis.primitiveArrayPresence(flag, expected, observeProperty);
			if (mutable || flag || result !== true) throw new Error("primitive presence loop");
			rows.push(result);
		} catch (error) {
			if ((!mutable && !flag) || !(error instanceof TypeError)) throw error;
			propertyEvents.push("presence:TypeError");
		}
		try {
			const pair = globalThis.primitiveArrayDestructure(flag, observeProperty);
			collectGarbage?.();
			if (flag) {
				if (pair[0] !== "A" || pair[1] !== "𝌆")
					throw new Error("String iteration code points");
			} else if (!mutable || pair[0].keep[1] !== "retained" || pair[1] !== "second")
				throw new Error("primitive custom Array iterator");
			rows.push(pair);
		} catch (error) {
			if (mutable || flag || !(error instanceof TypeError)) throw error;
			propertyEvents.push("iterator:TypeError");
		}
		try {
			const previous = globalThis.primitiveNumericUpdate(flag, observeProperty);
			if (!mutable || flag || previous !== 42)
				throw new Error("primitive numeric update");
			rows.push(previous);
		} catch (error) {
			if ((mutable && !flag) || !(error instanceof TypeError)) throw error;
			propertyEvents.push("update:TypeError");
		}
		for (const write of [
			() => globalThis.namedPrimitiveWrite(flag, makePropertyValue, observeProperty),
			() => globalThis.indexedPrimitiveWrite(flag, 0, makePropertyValue, observeProperty),
			() =>
				globalThis.indexedPrimitiveWrite(
					flag,
					coercingKey,
					makePropertyValue,
					observeProperty,
				),
			() => {
				const iterator = globalThis.suspendedPrimitiveWrite(
					flag,
					coercingKey,
					makePropertyValue,
					observeProperty,
				);
				const first = iterator.next();
				if (first.done || typeof first.value !== (flag ? "string" : "number"))
					throw new Error("primitive receiver suspension");
				collectGarbage?.();
				const last = iterator.next();
				if (!last.done) throw new Error("primitive receiver completion");
				return last.value;
			},
		]) {
			try {
				const value = write();
				if (!mutable || flag) throw new Error("missing primitive store error");
				collectGarbage?.();
				if (value !== receivedValue || value.keep[1] !== "retained")
					throw new Error("primitive assignment result root");
			} catch (error) {
				if ((mutable && !flag) || !(error instanceof TypeError)) throw error;
				propertyEvents.push("TypeError");
			}
		}
		rows.push(propertyEvents.join("|"));
	}
	if (mutable) {
		throwAccessor = true;
		for (const access of [
			() => globalThis.indexedPrimitiveRead(false, 0, observeProperty),
			() => globalThis.namedPrimitiveWrite(false, makePropertyValue, observeProperty),
			() => globalThis.primitiveArrayDestructure(false, observeProperty),
		]) {
			try {
				access();
				throw new Error("missing primitive accessor exception");
			} catch (error) {
				if (error !== thrown) throw error;
			}
		}
	}
} finally {
	if (mutable) for (const [prototype, key] of installations) delete prototype[key];
}
const conditionalEvents = [];
const conditionalObserve = (value) => {
	conditionalEvents.push(typeof value);
	collectGarbage?.();
	return value;
};
for (const value of ["", "A𝌆Z", null, undefined, 42, { length: 19 }]) {
	const expected = typeof value === "string" ? value.length : -1;
	if (globalThis.branchStringLength(value) !== expected)
		throw new Error("conditional string length");
	if (
		globalThis.branchStringJoin(value, conditionalObserve) !==
		(typeof value === "string" ? value.length : 8)
	)
		throw new Error("conditional string join");
	const iterator = globalThis.branchSuspendedLength(value, conditionalObserve);
	const first = iterator.next();
	collectGarbage?.();
	const result = first.done ? first : iterator.next();
	if (!result.done || result.value !== expected)
		throw new Error("conditional suspended length");
	rows.push(expected);
}
for (const value of [
	null,
	undefined,
	false,
	true,
	0,
	42,
	0n,
	3n,
	"",
	"text",
	Symbol("key"),
	{},
	() => 1,
]) {
	if (globalThis.branchCoercible(value, conditionalObserve) !== (value ? 7 : -1))
		throw new Error("conditional coercibility");
	if (
		globalThis.branchObservation(value, conditionalObserve) !==
		(typeof value !== "string")
	)
		throw new Error("conditional observation");
}
const conditionalSymbol = Symbol("conditional key");
const conditionalObject = {
	get length() {
		conditionalEvents.push("length");
		collectGarbage?.();
		return 23;
	},
	get [conditionalSymbol]() {
		conditionalEvents.push("symbol");
		collectGarbage?.();
		return 29;
	},
};
if (
	globalThis.branchObjectProperty(conditionalObject, conditionalObserve) !== 23 ||
	globalThis.branchObjectProperty(null, conditionalObserve) !== -1
)
	throw new Error("conditional object access");
if (
	globalThis.branchSymbolProperty(
		conditionalObject,
		conditionalSymbol,
		conditionalObserve,
	) !== 29
)
	throw new Error("conditional symbol access");
try {
	globalThis.branchSymbolProperty(null, conditionalSymbol, conditionalObserve);
	throw new Error("missing conditional null receiver exception");
} catch (error) {
	if (!(error instanceof TypeError)) throw error;
}
const conditionalProxy = new Proxy(
	{},
	{
		get(target, key) {
			conditionalEvents.push(String(key));
			collectGarbage?.();
			if (key === "length") return 31;
			throw thrown;
		},
	},
);
if (
	globalThis.branchObjectProperty(conditionalProxy, conditionalObserve) !== 31 ||
	globalThis.branchObjectProperty(new String("A𝌆"), conditionalObserve) !== 3
)
	throw new Error("conditional object brands");
try {
	globalThis.branchSymbolProperty(
		conditionalProxy,
		conditionalSymbol,
		conditionalObserve,
	);
	throw new Error("missing conditional proxy exception");
} catch (error) {
	if (error !== thrown) throw error;
}
for (const flag of [true, false, undefined]) {
	for (const [read, expected] of [
		[globalThis.nullableStringLength, 8],
		[globalThis.nullableLengthForward, 8],
		[globalThis.nullableLengthObservation, true],
	]) {
		try {
			const result = read(flag, conditionalObserve);
			if (!flag || result !== expected) throw new Error("nullable length result");
			rows.push(result);
		} catch (error) {
			if (flag || !(error instanceof TypeError)) throw error;
			rows.push("null length throws");
		}
	}
	try {
		const result = globalThis.nullableLengthPredicates(flag, conditionalObserve);
		if (!flag || result.join(",") !== "false,true,true,true,false,4")
			throw new Error("length range predicates");
		rows.push(result);
	} catch (error) {
		if (flag || !(error instanceof TypeError)) throw error;
		rows.push("predicate null length throws");
	}
	const iterator = globalThis.nullableSuspendedLength(flag, conditionalObserve);
	const first = iterator.next();
	if (first.done) throw new Error("missing nullable suspension");
	collectGarbage?.();
	try {
		const result = iterator.next();
		if (!flag || !result.done || result.value !== 8)
			throw new Error("nullable resumed length");
		rows.push(result.value);
	} catch (error) {
		if (flag || !(error instanceof TypeError)) throw error;
		rows.push("resumed null length throws");
	}
}
const lengthSuffix = {
	[Symbol.toPrimitive](hint) {
		conditionalEvents.push(hint);
		collectGarbage?.();
		return "xy";
	},
};
if (
	globalThis.nullableStringLength(true, (value) =>
		value === "" ? lengthSuffix : value,
	) !== 12
)
	throw new Error("length input coercion");
for (const suffix of [
	Symbol("throws"),
	{
		[Symbol.toPrimitive]() {
			collectGarbage?.();
			throw thrown;
		},
	},
]) {
	try {
		globalThis.nullableStringLength(true, (value) => (value === "" ? suffix : value));
		throw new Error("missing length input coercion exception");
	} catch (error) {
		if (typeof suffix === "symbol" ? !(error instanceof TypeError) : error !== thrown)
			throw error;
	}
}
const mixedLengthObserver = () => ({
	get length() {
		collectGarbage?.();
		return "kept";
	},
});
if (
	globalThis.mixedStringLength(false, mixedLengthObserver) !== "kept" ||
	globalThis.mixedStringLength(true, conditionalObserve) !== 5
)
	throw new Error("mixed object length result");
rows.push(conditionalEvents);
rows.push(order, inheritedWrites);

if (!globalThis.privateArrayLengthPredicates(5, conditionalObserve))
	throw new Error("private Array length predicate");
for (const n of [0.5, -1, NaN, Infinity, -0]) {
	const expected = [
		Number.isNaN(n),
		Number.isFinite(n),
		Number.isInteger(n),
		Number.isSafeInteger(n),
		n < 0,
		Math.abs(n),
	].join(",");
	for (const value of [
		{
			get length() {
				collectGarbage?.();
				return n;
			},
		},
		new Proxy([], {
			get(target, key) {
				collectGarbage?.();
				return key === "length" ? n : Reflect.get(target, key);
			},
		}),
	]) {
		if (
			globalThis.objectLengthPredicates(value, conditionalObserve).join(",") !== expected
		)
			throw new Error("object or Proxy length narrowed");
	}
}

if (mutable) {
	const descriptor = Object.getOwnPropertyDescriptor(Number, "isInteger");
	const predicateEvents = [];
	try {
		Object.defineProperty(Number, "isInteger", {
			configurable: true,
			get() {
				predicateEvents.push("get");
				collectGarbage?.();
				return function (n) {
					predicateEvents.push("call");
					collectGarbage?.();
					return n + 0.5;
				};
			},
		});
		if (
			globalThis.lengthPredicateOrder("abc") !== 4.5 ||
			predicateEvents.join(",") !== "get,call"
		)
			throw new Error("mutable predicate fallback");
		predicateEvents.length = 0;
		try {
			globalThis.lengthPredicateOrder(null);
			throw new Error("missing predicate argument throw");
		} catch (error) {
			if (!(error instanceof TypeError) || predicateEvents.join(",") !== "get")
				throw error;
		}
	} finally {
		Object.defineProperty(Number, "isInteger", descriptor);
	}
}

console.log(JSON.stringify(rows));
