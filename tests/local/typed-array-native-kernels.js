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

function dynamicLoad(view, key) {
	return view[key];
}

function dynamicStore(view, key, value) {
	view[key] = value;
}

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
