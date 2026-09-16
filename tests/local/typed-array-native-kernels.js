const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

const variants = [
	[Int8Array, false],
	[Uint8Array, false],
	[Uint8ClampedArray, false],
	[Int16Array, false],
	[Uint16Array, false],
	[Int32Array, false],
	[Uint32Array, false],
	[Float32Array, false],
	[Float64Array, false],
	[BigInt64Array, true],
	[BigUint64Array, true],
];

for (const [Ctor, bigint] of variants) {
	const one = bigint ? 1n : 1;
	const two = bigint ? 2n : 2;
	const three = bigint ? 3n : 3;
	const four = bigint ? 4n : 4;
	const seven = bigint ? 7n : 7;
	const nine = bigint ? 9n : 9;
	const source = new Ctor([one, two, three, four]);
	const fromEmpty = Ctor.from([]);
	const fromShort = Ctor.from([one, two]);
	const ofShort = Ctor.of(three, four);
	const copied = new Ctor(source);
	copied.fill(nine, 1, 3);
	copied.reverse();
	const reversed = copied.toReversed();
	const sliced = copied.slice(1, 3);
	const replaced = copied.with(2, seven);
	const setCopy = new Ctor(4);
	setCopy.set(source);
	const sorted = new Ctor([four, one, three, two]);
	sorted.sort();
	const sub = source.subarray(1, 3);
	sub[0] = nine;
	check(
		Ctor.name + " raw kernels",
		fromEmpty.length === 0 &&
			fromShort.join() === [one, two].join() &&
			ofShort.join() === [three, four].join() &&
			Object.getPrototypeOf(fromShort) === Ctor.prototype &&
			Object.getPrototypeOf(ofShort) === Ctor.prototype &&
			copied.join() === [four, nine, nine, one].join() &&
			reversed.join() === [one, nine, nine, four].join() &&
			sliced.join() === [nine, nine].join() &&
			replaced.join() === [four, nine, seven, one].join() &&
			setCopy.join() === [one, two, three, four].join() &&
			sorted.join() === [one, two, three, four].join() &&
			copied.indexOf(nine) === 1 &&
			copied.lastIndexOf(nine) === 2 &&
			copied.includes(nine) &&
			source[1] === nine,
	);
}

const uniformInt32Fill = new Int32Array([7, 7, 7, 7, 7]);
uniformInt32Fill.fill(-1, 1, 4);
const uniformUint32Fill = new Uint32Array([9, 9, 9, 9, 9]);
uniformUint32Fill.fill(0, 1, 4);
const uniformBigIntFill = new BigInt64Array([3n, 3n, 3n]);
uniformBigIntFill.fill(-1n);
const negativeZeroFill = new Float64Array(3);
negativeZeroFill.fill(-0);
const sharedUniformFill = new Int32Array(
	new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
);
sharedUniformFill.fill(-1);
check(
	"multi-byte uniform fill preserves element bits and range boundaries",
	uniformInt32Fill.join() === "7,-1,-1,-1,7" &&
		uniformUint32Fill.join() === "9,0,0,0,9" &&
		uniformBigIntFill.join() === "-1,-1,-1" &&
		negativeZeroFill.every((value) => Object.is(value, -0)) &&
		sharedUniformFill.join() === "-1,-1,-1",
);

function dynamicLoad(view, key) {
	return view[key];
}

function dynamicStore(view, key, value) {
	view[key] = value;
}

// These receivers originate at locked intrinsic constructors and cross a
// closure/global-cell boundary. Compiled mode may consume their exact immutable
// brands, but observable element values still have to honor each scalar kind,
// boxed non-numeric property keys, detachment, and resize.
const exactInt8 = new Int8Array([-1]);
const exactUint8 = new Uint8Array([255]);
const exactClamped = new Uint8ClampedArray([254.6]);
const exactInt16 = new Int16Array([-1234]);
const exactUint16 = new Uint16Array([60000]);
const exactInt32 = new Int32Array([-1234567]);
const exactUint32 = new Uint32Array([4000000000]);
const exactFloat32 = new Float32Array([1.5]);
const exactFloat64 = new Float64Array([-3.25]);
exactInt32.label = "exact-brand-fallback";
function exactCapturedLoads(key) {
	return [
		exactInt8[key],
		exactUint8[key],
		exactClamped[key],
		exactInt16[key],
		exactUint16[key],
		exactInt32[key],
		exactUint32[key],
		exactFloat32[key],
		exactFloat64[key],
	];
}
check(
	"exact captured numeric TypedArray brands preserve scalar loads",
	exactCapturedLoads(0).join() ===
		"-1,255,255,-1234,60000,-1234567,4000000000,1.5,-3.25" &&
		exactCapturedLoads("label")[5] === "exact-brand-fallback",
);

function exactPassedLoad(view, index) {
	return view[index];
}
check(
	"exact numeric TypedArray brand crosses a named call",
	exactPassedLoad(exactInt32, 0) === -1234567 &&
		exactPassedLoad(exactFloat64, 0) === -3.25,
);

function publishedIndexedLoad(receiver, index) {
	return receiver[index];
}
globalThis.__mal_published_indexed_load = publishedIndexedLoad;
check(
	"published indexed receiver accepts a TypedArray",
	globalThis.__mal_published_indexed_load(exactInt32, 0) === -1234567,
);
check(
	"published indexed receiver remains open",
	globalThis.__mal_published_indexed_load({ 0: "ordinary" }, 0) === "ordinary",
);

const exactExternalBuffer = new ArrayBuffer(8, { maxByteLength: 8 });
const exactExternalView = new Uint8Array(exactExternalBuffer, 4, 4);
function exactExternalLoad(key) {
	return exactExternalView[key];
}
exactExternalBuffer.resize(2);
check(
	"exact captured brand retains current resized extent",
	exactExternalLoad(0) === undefined,
);

const exactDetachedView = new Uint8Array([8]);
function exactDetachedLoad(key) {
	return exactDetachedView[key];
}
exactDetachedView.buffer.transfer();
check(
	"exact captured brand retains current detached extent",
	exactDetachedLoad(0) === undefined,
);

const dynamic = new Uint32Array(16);
let dynamicChecksum = 0;
for (let index = 0; index < 5000; index++) {
	const key = index & 15;
	const value = index * 3 + 1;
	dynamicStore(dynamic, key, value);
	dynamicChecksum += dynamicLoad(dynamic, key);
}
check(
	"dynamic integer-indexed load/store",
	dynamicChecksum === 37497500 && dynamicLoad(dynamic, "0") === dynamic[0],
);

function indexedSum(values) {
	let total = 0;
	for (let index = 0; index < values.length; index++) total += values[index];
	return total;
}

function indexedIncrement(values) {
	for (let index = 0; index < values.length; index++) values[index] = values[index] + 1;
}

const indexedUint8 = new Uint8Array([1, 2, 3, 4]);
const indexedFloat64 = new Float64Array([0.5, 1.25, -2]);
indexedIncrement(indexedUint8);
check(
	"guarded numeric TypedArray indexed loops",
	indexedSum(indexedUint8) === 14 && indexedSum(indexedFloat64) === -0.25,
);

const shadowedLength = new Uint8Array([7, 8, 9]);
Object.defineProperty(shadowedLength, "length", { value: 1 });
check("indexed loop falls back for an own length", indexedSum(shadowedLength) === 7);

function indexedBigIntSum(values) {
	let total = 0n;
	for (let index = 0; index < values.length; index++) total += values[index];
	return total;
}
check(
	"indexed loop falls back for BigInt TypedArrays",
	indexedBigIntSum(new BigInt64Array([2n, 3n, 5n])) === 10n,
);

dynamicStore(dynamic, -0, 91);
check("dynamic negative zero addresses zero", dynamicLoad(dynamic, -0) === 91);

Object.defineProperty(Uint32Array.prototype, "99", {
	configurable: true,
	value: 1234,
});
let invalidStoreCoercions = 0;
dynamicStore(dynamic, 99, {
	valueOf() {
		invalidStoreCoercions++;
		return 77;
	},
});
check(
	"dynamic out-of-bounds index owns the miss and coerces the store value",
	dynamicLoad(dynamic, 99) === undefined && invalidStoreCoercions === 1,
);
check(
	"dynamic invalid numeric indices stay integer-indexed exotic",
	[-1, 1.5, 4294967295, Infinity, NaN].every(
		(key) => dynamicLoad(dynamic, key) === undefined,
	),
);
delete Uint32Array.prototype[99];

const detachedDynamic = new Uint8Array([4]);
detachedDynamic.buffer.transfer();
let detachedStoreCoercions = 0;
dynamicStore(detachedDynamic, 0, {
	valueOf() {
		detachedStoreCoercions++;
		return 5;
	},
});
check(
	"dynamic detached view observes the current extent",
	dynamicLoad(detachedDynamic, 0) === undefined && detachedStoreCoercions === 1,
);

const resizedDynamicBuffer = new ArrayBuffer(8, { maxByteLength: 8 });
const resizedDynamic = new Uint8Array(resizedDynamicBuffer, 4, 4);
resizedDynamicBuffer.resize(2);
let resizedStoreCoercions = 0;
dynamicStore(resizedDynamic, 0, {
	valueOf() {
		resizedStoreCoercions++;
		return 6;
	},
});
check(
	"dynamic out-of-bounds fixed view observes resize",
	dynamicLoad(resizedDynamic, 0) === undefined && resizedStoreCoercions === 1,
);

const dynamicBigInt = new BigInt64Array(2);
dynamicStore(dynamicBigInt, 1, 17n);
let dynamicBigIntRejectedNumber = false;
try {
	dynamicStore(dynamicBigInt, 0, 17);
} catch (error) {
	dynamicBigIntRejectedNumber = error instanceof TypeError;
}
check(
	"dynamic BigInt element coercion",
	dynamicLoad(dynamicBigInt, 1) === 17n && dynamicBigIntRejectedNumber,
);

const clamped = new Uint8ClampedArray(4);
clamped.fill(2.5, 0, 1);
clamped.fill(3.5, 1, 2);
clamped.fill(-1, 2, 3);
clamped.fill(300, 3);
check("Uint8Clamp ties and limits", clamped.join() === "2,4,0,255");

const floatBits = new ArrayBuffer(24);
const floatWords = new Uint32Array(floatBits);
floatWords.set([0x7fc00001, 0x40400000, 0x7fc00002, 0x80000000, 0, 0xc0000000]);
const floats = new Float32Array(floatBits);
floats.sort();
check(
	"Float32 sort keeps -0 before +0 and stable NaN payloads",
	floatWords.join() ===
		[0xc0000000, 0x80000000, 0, 0x40400000, 0x7fc00001, 0x7fc00002].join(),
);

const crossNumeric = new Int16Array(new Float64Array([1.9, -2.1, 65537]));
const crossBigInt = new BigUint64Array(new BigInt64Array([-1n, 2n]));
check("cross-kind native conversion", crossNumeric.join() === "1,-2,1");
check(
	"cross-kind BigInt conversion",
	crossBigInt[0] === 0xffffffffffffffffn && crossBigInt[1] === 2n,
);

const denseFromSource = [];
for (let index = 0; index < 65; index++) denseFromSource.push(index * 17 - 200);
check(
	"TypedArray.from converts dense numeric arrays across snapshot growth boundaries",
	Uint8Array.from([]).length === 0 &&
		Int32Array.from([7])[0] === 7 &&
		Uint32Array.from(denseFromSource).join() ===
			denseFromSource.map((value) => value >>> 0).join(),
);

const reservationBoundaries = [8, 9, 16, 17].map((length) =>
	Array.from({ length }, (_, index) => index),
);
const partiallyConsumedReservationIterator = Array.from(
	{ length: 20 },
	(_, index) => index,
).values();
for (let index = 0; index < 11; index++) partiallyConsumedReservationIterator.next();
check(
	"TypedArray.from preserves reservation boundaries and remaining iterator length",
	reservationBoundaries.every(
		(source) => Uint8Array.from(source).join() === source.join(),
	) &&
		Uint8Array.from(partiallyConsumedReservationIterator).join() ===
			"11,12,13,14,15,16,17,18,19",
);

const growingReservedFromSource = Array.from({ length: 9 }, (_, index) => index);
delete growingReservedFromSource[4];
const growingReservedFromPrototype = Object.create(Array.prototype);
Object.defineProperty(growingReservedFromPrototype, 4, {
	configurable: true,
	get() {
		while (growingReservedFromSource.length < 19)
			growingReservedFromSource.push(growingReservedFromSource.length);
		return 4;
	},
});
Object.setPrototypeOf(growingReservedFromSource, growingReservedFromPrototype);
check(
	"TypedArray.from grows a reserved snapshot after an inherited getter extends iteration",
	Uint8Array.from(growingReservedFromSource).join() ===
		Array.from({ length: 19 }, (_, index) => index).join(),
);

const shrinkingReservedFromSource = Array.from({ length: 9 }, (_, index) => index);
delete shrinkingReservedFromSource[4];
const shrinkingReservedFromPrototype = Object.create(Array.prototype);
let shrinkingReservedConversions = 0;
Object.defineProperty(shrinkingReservedFromPrototype, 4, {
	configurable: true,
	get() {
		shrinkingReservedFromSource.length = 5;
		return {
			valueOf() {
				shrinkingReservedConversions++;
				return 4;
			},
		};
	},
});
Object.setPrototypeOf(shrinkingReservedFromSource, shrinkingReservedFromPrototype);
check(
	"TypedArray.from traces only populated reserved snapshot entries after shrink",
	Uint8Array.from(shrinkingReservedFromSource).join() === "0,1,2,3,4" &&
		shrinkingReservedConversions === 1,
);

const partiallyConsumedArrayIterator = [11, 22, 33].values();
partiallyConsumedArrayIterator.next();
const exhaustedArrayIterator = [44].values();
exhaustedArrayIterator.next();
exhaustedArrayIterator.next();
check(
	"TypedArray.from preserves Array iterator cursor state",
	Uint8Array.from(partiallyConsumedArrayIterator).join() === "22,33" &&
		Uint8Array.from(exhaustedArrayIterator).length === 0,
);

const shrinkingFromSource = [1, 0, 3, 4];
Object.defineProperty(shrinkingFromSource, 1, {
	configurable: true,
	get() {
		shrinkingFromSource.length = 2;
		return 2;
	},
});
const growingFromSource = [1, 0];
Object.defineProperty(growingFromSource, 1, {
	configurable: true,
	get() {
		growingFromSource[2] = 3;
		return 2;
	},
});
check(
	"TypedArray.from Array cursor observes live source length",
	Uint8Array.from(shrinkingFromSource).join() === "1,2" &&
		Uint8Array.from(growingFromSource).join() === "1,2,3",
);

const overriddenNextIterator = [4, 5, 6].values();
const builtinArrayIteratorNext = overriddenNextIterator.next;
let overriddenNextCalls = 0;
overriddenNextIterator.next = function () {
	overriddenNextCalls++;
	return builtinArrayIteratorNext.call(this);
};
check(
	"TypedArray.from honors an overridden Array iterator next",
	Uint8Array.from(overriddenNextIterator).join() === "4,5,6" && overriddenNextCalls === 4,
);

const fromOrder = [];
const orderedFromSource = [
	{
		valueOf() {
			fromOrder.push("convert-0");
			return 7;
		},
	},
	0,
];
Object.defineProperty(orderedFromSource, 1, {
	configurable: true,
	get() {
		fromOrder.push("collect-1");
		return {
			valueOf() {
				fromOrder.push("convert-1");
				return 8;
			},
		};
	},
});
const orderedFromThis = {};
let orderedFromThisMatches = true;
const orderedFromResult = Uint8Array.from(
	orderedFromSource,
	function (value, index) {
		orderedFromThisMatches = orderedFromThisMatches && this === orderedFromThis;
		fromOrder.push("map-" + index);
		return value;
	},
	orderedFromThis,
);
check(
	"TypedArray.from drains Array iteration before mapping and conversion",
	orderedFromResult.join() === "7,8" &&
		orderedFromThisMatches &&
		fromOrder.join() === "collect-1,map-0,convert-0,map-1,convert-1",
);

let observedPrefixDestination;
let observedPrefix = "";
let observedPrefixConversions = 0;
function ObservedPrefixInt32Array(length) {
	observedPrefixDestination = new Int32Array(length);
	return observedPrefixDestination;
}
const observedPrefixResult = Int32Array.from.call(ObservedPrefixInt32Array, [
	11,
	22,
	{
		valueOf() {
			fromOrder.push("prefix-middle");
			observedPrefix = observedPrefixDestination.slice(0, 2).join();
			observedPrefixConversions++;
			Array.from({ length: 1_024 }, (_, index) => ({ index }));
			return 33;
		},
	},
	{
		valueOf() {
			fromOrder.push("prefix-suffix");
			return 44;
		},
	},
]);
check(
	"TypedArray.from exposes numeric prefix writes before object coercion",
	observedPrefixResult.join() === "11,22,33,44" &&
		observedPrefix === "11,22" &&
		observedPrefixConversions === 1 &&
		fromOrder.slice(-2).join() === "prefix-middle,prefix-suffix",
);

let edgePrefixDestination;
function EdgePrefixInt32Array(length) {
	edgePrefixDestination = new Int32Array(length);
	return edgePrefixDestination;
}
let firstPrefixObserved = "";
let lastPrefixObserved = "";
const firstPrefixResult = Int32Array.from.call(EdgePrefixInt32Array, [
	{
		valueOf() {
			firstPrefixObserved = edgePrefixDestination.join();
			return 47;
		},
	},
	53,
	59,
]);
const lastPrefixResult = Int32Array.from.call(EdgePrefixInt32Array, [
	61,
	67,
	{
		valueOf() {
			lastPrefixObserved = edgePrefixDestination.slice(0, 2).join();
			return 71;
		},
	},
]);
check(
	"TypedArray.from enters object coercion at the first and last snapshot positions",
	firstPrefixObserved === "0,0,0" &&
		firstPrefixResult.join() === "47,53,59" &&
		lastPrefixObserved === "61,67" &&
		lastPrefixResult.join() === "61,67,71",
);

let throwingPrefixDestination;
function ThrowingPrefixInt32Array(length) {
	throwingPrefixDestination = new Int32Array(length);
	return throwingPrefixDestination;
}
let throwingPrefixCaught = false;
let coercionAfterThrow = 0;
try {
	Int32Array.from.call(ThrowingPrefixInt32Array, [
		5,
		6,
		{
			valueOf() {
				throw new Error("prefix conversion");
			},
		},
		{
			valueOf() {
				coercionAfterThrow++;
				return 8;
			},
		},
	]);
} catch (error) {
	throwingPrefixCaught = error.message === "prefix conversion";
}
check(
	"TypedArray.from preserves numeric prefix when later coercion throws",
	throwingPrefixCaught &&
		throwingPrefixDestination.join() === "5,6,0,0" &&
		coercionAfterThrow === 0,
);

let detachedPrefixDestination;
let transferredPrefixBuffer;
let coercionAfterDetach = 0;
function DetachedPrefixInt32Array(length) {
	detachedPrefixDestination = new Int32Array(length);
	return detachedPrefixDestination;
}
const detachedPrefixResult = Int32Array.from.call(DetachedPrefixInt32Array, [
	7,
	8,
	{
		valueOf() {
			transferredPrefixBuffer = detachedPrefixDestination.buffer.transfer();
			return 9;
		},
	},
	{
		valueOf() {
			coercionAfterDetach++;
			return 10;
		},
	},
]);
check(
	"TypedArray.from discards suffix writes after object coercion detaches the destination",
	detachedPrefixResult.buffer.detached &&
		new Int32Array(transferredPrefixBuffer).join() === "7,8,0,0" &&
		coercionAfterDetach === 1,
);

let offsetBacking;
function OffsetInt32Array(length) {
	offsetBacking = new Int32Array(length + 2);
	offsetBacking[0] = 71;
	offsetBacking[length + 1] = 73;
	return new Int32Array(offsetBacking.buffer, Int32Array.BYTES_PER_ELEMENT, length);
}
const offsetFrom = Int32Array.from.call(OffsetInt32Array, [13, 17, 19]);
let oversizedDestination;
function OversizedInt32Array(length) {
	oversizedDestination = new Int32Array(length + 2);
	oversizedDestination.fill(79);
	return oversizedDestination;
}
const oversizedFrom = Int32Array.from.call(OversizedInt32Array, [23, 29, 31]);
check(
	"TypedArray.from numeric prefix honors offsets and leaves oversized tails untouched",
	offsetFrom.join() === "13,17,19" &&
		offsetBacking.join() === "71,13,17,19,73" &&
		oversizedFrom.join() === "23,29,31,79,79",
);

let resizableDestination;
function ResizableInt32Array(length) {
	const byteLength = length * Int32Array.BYTES_PER_ELEMENT;
	resizableDestination = new Int32Array(
		new ArrayBuffer(byteLength, { maxByteLength: byteLength * 2 }),
	);
	return resizableDestination;
}
const resizableFrom = Int32Array.from.call(ResizableInt32Array, [37, 41, 43]);
let resizedDuringCoercion = false;
const resizingFrom = Int32Array.from.call(ResizableInt32Array, [
	47,
	{
		valueOf() {
			resizableDestination.buffer.resize(Int32Array.BYTES_PER_ELEMENT);
			resizableDestination.buffer.resize(3 * Int32Array.BYTES_PER_ELEMENT);
			resizedDuringCoercion = true;
			return 53;
		},
	},
	59,
]);
let sharedDestination;
function SharedInt32Array(length) {
	sharedDestination = new Int32Array(
		new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
	);
	return sharedDestination;
}
let sharedPrefixObserved = 0;
const sharedFrom = Int32Array.from.call(SharedInt32Array, [
	61,
	{
		valueOf() {
			sharedPrefixObserved = sharedDestination[0];
			return 67;
		},
	},
	71,
]);
check(
	"TypedArray.from writes numeric snapshots through resizable and shared custom results",
	resizableFrom.join() === "37,41,43" &&
		resizedDuringCoercion &&
		resizingFrom.join() === "47,53,59" &&
		sharedPrefixObserved === 61 &&
		sharedFrom.join() === "61,67,71",
);

const numericPrefixClamped = Uint8ClampedArray.from([-1, 0.5, 1.5, 254.5, 300, NaN]);
const numericPrefixWrapped = Int8Array.from([-129, 128, 257]);
const numericPrefixFloats = Float64Array.from([NaN, -0, 0]);
const numericPrefixInfinities = Uint8Array.from([Infinity, -Infinity]);
check(
	"TypedArray.from numeric prefix preserves scalar conversion edges",
	numericPrefixClamped.join() === "0,0,2,254,255,0" &&
		numericPrefixWrapped.join() === "127,-128,1" &&
		Number.isNaN(numericPrefixFloats[0]) &&
		Object.is(numericPrefixFloats[1], -0) &&
		Object.is(numericPrefixFloats[2], 0) &&
		numericPrefixInfinities.join() === "0,0",
);

function BigIntResult(length) {
	return new BigInt64Array(length);
}
function NumberResult(length) {
	return new Int32Array(length);
}
const customBigIntFrom = Int32Array.from.call(BigIntResult, [73n, 79n]);
let customBigIntRejectedNumbers = false;
let customNumberRejectedBigInts = false;
try {
	Int32Array.from.call(BigIntResult, [73, 79]);
} catch (error) {
	customBigIntRejectedNumbers = error instanceof TypeError;
}
try {
	BigInt64Array.from.call(NumberResult, [73n, 79n]);
} catch (error) {
	customNumberRejectedBigInts = error instanceof TypeError;
}
check(
	"TypedArray.from honors custom result numeric domains",
	customBigIntFrom[0] === 73n &&
		customBigIntFrom[1] === 79n &&
		customBigIntRejectedNumbers &&
		customNumberRejectedBigInts,
);

const throwingFromSource = [1, 0, 3];
Object.defineProperty(throwingFromSource, 1, {
	configurable: true,
	get() {
		throw new Error("from getter");
	},
});
let fromConstructorCalls = 0;
function TrackingUint8Array(length) {
	fromConstructorCalls++;
	return new Uint8Array(length);
}
let throwingFromCaught = false;
try {
	Uint8Array.from.call(TrackingUint8Array, throwingFromSource);
} catch (error) {
	throwingFromCaught = error.message === "from getter";
}
check(
	"TypedArray.from does not construct after Array iteration throws",
	throwingFromCaught && fromConstructorCalls === 0,
);

class DerivedUint16Array extends Uint16Array {}
const derivedFrom = Uint16Array.from.call(DerivedUint16Array, [3, 5, 8]);
const BoundUint16Array = Uint16Array.bind(null);
const boundFrom = Uint16Array.from.call(BoundUint16Array, [13, 21]);
let proxyConstructorCalls = 0;
const ProxyUint16Array = new Proxy(Uint16Array, {
	construct(target, args, newTarget) {
		proxyConstructorCalls++;
		return Reflect.construct(target, args, newTarget);
	},
});
const proxyFrom = Uint16Array.from.call(ProxyUint16Array, [34, 55]);
check(
	"TypedArray.from preserves non-intrinsic constructor dispatch",
	derivedFrom instanceof DerivedUint16Array &&
		derivedFrom.join() === "3,5,8" &&
		boundFrom.join() === "13,21" &&
		proxyFrom.join() === "34,55" &&
		proxyConstructorCalls === 1,
);

function NonTypedArrayConstructor() {
	return {};
}
function ShortTypedArrayConstructor(length) {
	return new Uint8Array(Math.max(0, length - 1));
}
function ImmutableTypedArrayConstructor(length) {
	return new Uint8Array(new ArrayBuffer(length).transferToImmutable());
}
let nonTypedArrayRejected = false;
let shortTypedArrayRejected = false;
let immutableTypedArrayRejected = false;
try {
	Uint8Array.of.call(NonTypedArrayConstructor, 1);
} catch (error) {
	nonTypedArrayRejected = error instanceof TypeError;
}
try {
	Uint8Array.from.call(ShortTypedArrayConstructor, [1, 2]);
} catch (error) {
	shortTypedArrayRejected = error instanceof TypeError;
}
try {
	Uint8Array.of.call(ImmutableTypedArrayConstructor, 1);
} catch (error) {
	immutableTypedArrayRejected = error instanceof TypeError;
}
check(
	"TypedArray static construction validates custom constructor results",
	nonTypedArrayRejected && shortTypedArrayRejected && immutableTypedArrayRejected,
);

let bigintFromNumberRejected = false;
let numberFromBigintRejected = false;
try {
	BigInt64Array.from([1]);
} catch (error) {
	bigintFromNumberRejected = error instanceof TypeError;
}
try {
	Int32Array.of(1n);
} catch (error) {
	numberFromBigintRejected = error instanceof TypeError;
}
check(
	"TypedArray intrinsic construction preserves numeric domain errors",
	bigintFromNumberRejected && numberFromBigintRejected,
);

const resizable = new ArrayBuffer(4, { maxByteLength: 64 });
new Uint8Array(resizable).fill(0xaa);
resizable.resize(2);
resizable.resize(32);
const grown = new Uint8Array(resizable);
let zeroed = true;
for (let i = 2; i < grown.length; i++) zeroed = zeroed && grown[i] === 0;
check("resizable growth exposes only zeroed bytes", zeroed);

const slicedBuffer = new Uint8Array([1, 2, 3, 4]).buffer.slice(1, 3);
check("ArrayBuffer slice copies bytes", new Uint8Array(slicedBuffer).join() === "2,3");

const movable = new Uint8Array([9, 8, 7, 6]).buffer;
const moved = movable.transfer();
check(
	"ArrayBuffer transfer moves fixed storage",
	movable.detached &&
		moved.byteLength === 4 &&
		new Uint8Array(moved).join() === "9,8,7,6",
);

const movableResizable = new ArrayBuffer(4, { maxByteLength: 16 });
new Uint8Array(movableResizable).set([1, 3, 5, 7]);
const movedResizable = movableResizable.transfer();
check(
	"ArrayBuffer transfer preserves resizability",
	movableResizable.detached &&
		movedResizable.resizable &&
		movedResizable.maxByteLength === 16 &&
		new Uint8Array(movedResizable).join() === "1,3,5,7",
);

const fixedSource = new ArrayBuffer(4, { maxByteLength: 16 });
new Uint8Array(fixedSource).set([2, 4, 6, 8]);
const transferredFixed = fixedSource.transferToFixedLength();
check(
	"transferToFixedLength drops resizability",
	fixedSource.detached &&
		!transferredFixed.resizable &&
		transferredFixed.maxByteLength === 4 &&
		new Uint8Array(transferredFixed).join() === "2,4,6,8",
);

const grownTransferSource = new Uint8Array([4, 2]).buffer;
const grownTransfer = grownTransferSource.transfer(5);
check(
	"ArrayBuffer transfer zeroes an extended tail",
	new Uint8Array(grownTransfer).join() === "4,2,0,0,0",
);

const immutableSource = new Uint8Array([6, 7, 8]).buffer;
const immutable = immutableSource.transferToImmutable();
let immutableWriteThrew = false;
try {
	new Uint8Array(immutable)[0] = 1;
} catch (error) {
	immutableWriteThrew = error instanceof TypeError;
}
const immutableSlice = new Uint8Array([3, 4, 5, 6]).buffer.sliceToImmutable(1, 3);
check(
	"immutable ArrayBuffer transfer and slice",
	immutableSource.detached &&
		immutable.immutable &&
		immutableWriteThrew &&
		immutableSlice.immutable &&
		new Uint8Array(immutableSlice).join() === "4,5",
);

const shared = new SharedArrayBuffer(4, { maxByteLength: 16 });
new Uint8Array(shared).set([5, 6, 7, 8]);
shared.grow(8);
const sharedSlice = shared.slice(1, 4);
check(
	"SharedArrayBuffer grow and slice",
	shared.byteLength === 8 && new Uint8Array(sharedSlice).join() === "6,7,8",
);

const data = new ArrayBuffer(64);
const view = new DataView(data);
view.setInt8(0, -7);
view.setUint8(1, 250);
view.setInt16(2, -1234, true);
view.setUint16(4, 60000, false);
view.setInt32(6, -1234567, true);
view.setUint32(10, 4000000000, false);
view.setFloat16(14, 1.5, true);
view.setFloat32(16, -3.25, false);
view.setFloat64(24, 3.5, true);
view.setBigInt64(32, -9n, false);
view.setBigUint64(40, 0xfffffffffffffff0n, true);
check(
	"DataView scalar load/store variants",
	view.getInt8(0) === -7 &&
		view.getUint8(1) === 250 &&
		view.getInt16(2, true) === -1234 &&
		view.getUint16(4, false) === 60000 &&
		view.getInt32(6, true) === -1234567 &&
		view.getUint32(10, false) === 4000000000 &&
		view.getFloat16(14, true) === 1.5 &&
		view.getFloat32(16, false) === -3.25 &&
		view.getFloat64(24, true) === 3.5 &&
		view.getBigInt64(32, false) === -9n &&
		view.getBigUint64(40, true) === 0xfffffffffffffff0n,
);
check(
	"ArrayBuffer.isView covers both view families",
	ArrayBuffer.isView(view) && ArrayBuffer.isView(floats),
);

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
