const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function bytesEqual(bytes, offset, expected) {
	for (let index = 0; index < expected.length; index++) {
		if (bytes[offset + index] !== expected[index]) return false;
	}
	return true;
}

function sameNumber(actual, expected) {
	return Object.is(actual, expected) || (Number.isNaN(actual) && Number.isNaN(expected));
}

const buffer = new ArrayBuffer(32);
const bytes = new Uint8Array(buffer);
const view = new DataView(buffer);
const offset = 1;

view.setInt8(offset, -2);
check("int8 signed unaligned", view.getInt8(offset) === -2 && bytes[offset] === 0xfe);
view.setUint8(offset, 0xa5);
check("uint8 unaligned", view.getUint8(offset) === 0xa5 && bytes[offset] === 0xa5);

function testInt16(name, setter, getter, value, bigEndianBytes) {
	view[setter](offset, value, false);
	check(
		name + " big endian",
		bytesEqual(bytes, offset, bigEndianBytes) && view[getter](offset, false) === value,
	);
	view[setter](offset, value, true);
	check(
		name + " little endian",
		bytesEqual(bytes, offset, bigEndianBytes.slice().reverse()) &&
			view[getter](offset, true) === value,
	);
}

function testInt32(name, setter, getter, value, bigEndianBytes) {
	view[setter](offset, value, false);
	check(
		name + " big endian",
		bytesEqual(bytes, offset, bigEndianBytes) && view[getter](offset, false) === value,
	);
	view[setter](offset, value, true);
	check(
		name + " little endian",
		bytesEqual(bytes, offset, bigEndianBytes.slice().reverse()) &&
			view[getter](offset, true) === value,
	);
}

function testBigInt64(name, setter, getter, value, bigEndianBytes) {
	view[setter](offset, value, false);
	check(
		name + " big endian",
		bytesEqual(bytes, offset, bigEndianBytes) && view[getter](offset, false) === value,
	);
	view[setter](offset, value, true);
	check(
		name + " little endian",
		bytesEqual(bytes, offset, bigEndianBytes.slice().reverse()) &&
			view[getter](offset, true) === value,
	);
}

testInt16("int16 signed unaligned", "setInt16", "getInt16", -0x1234, [0xed, 0xcc]);
testInt16("uint16 unaligned", "setUint16", "getUint16", 0xabcd, [0xab, 0xcd]);
testInt32(
	"int32 signed unaligned",
	"setInt32",
	"getInt32",
	-0x01234567,
	[0xfe, 0xdc, 0xba, 0x99],
);
testInt32(
	"uint32 unaligned",
	"setUint32",
	"getUint32",
	0x89abcdef,
	[0x89, 0xab, 0xcd, 0xef],
);
testBigInt64(
	"bigint64 signed unaligned",
	"setBigInt64",
	"getBigInt64",
	-0x0123456789abcdefn,
	[0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x11],
);
testBigInt64(
	"biguint64 unaligned",
	"setBigUint64",
	"getBigUint64",
	0x89abcdef01234567n,
	[0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67],
);

view.setFloat16(offset, -0, false);
check(
	"float16 big endian negative zero",
	bytesEqual(bytes, offset, [0x80, 0x00]) &&
		Object.is(view.getFloat16(offset, false), -0),
);
view.setFloat16(offset, -0, true);
check(
	"float16 little endian negative zero",
	bytesEqual(bytes, offset, [0x00, 0x80]) && Object.is(view.getFloat16(offset, true), -0),
);

view.setFloat32(offset, -12.5, false);
check(
	"float32 big endian unaligned",
	bytesEqual(bytes, offset, [0xc1, 0x48, 0x00, 0x00]) &&
		view.getFloat32(offset, false) === -12.5,
);
view.setFloat32(offset, -12.5, true);
check(
	"float32 little endian unaligned",
	bytesEqual(bytes, offset, [0x00, 0x00, 0x48, 0xc1]) &&
		view.getFloat32(offset, true) === -12.5,
);

view.setFloat64(offset, -0, false);
check(
	"float64 big endian negative zero unaligned",
	bytesEqual(bytes, offset, [0x80, 0, 0, 0, 0, 0, 0, 0]) &&
		Object.is(view.getFloat64(offset, false), -0),
);
view.setFloat64(offset, -0, true);
check(
	"float64 little endian negative zero unaligned",
	bytesEqual(bytes, offset, [0, 0, 0, 0, 0, 0, 0, 0x80]) &&
		Object.is(view.getFloat64(offset, true), -0),
);

view.setUint32(offset, 0x7fc12345, false);
check("float32 NaN big endian transport", Number.isNaN(view.getFloat32(offset, false)));
view.setUint32(offset, 0x7fc12345, true);
check("float32 NaN little endian transport", Number.isNaN(view.getFloat32(offset, true)));
view.setBigUint64(offset, 0x7ff8123456789abcn, false);
check("float64 NaN big endian transport", Number.isNaN(view.getFloat64(offset, false)));
view.setBigUint64(offset, 0x7ff8123456789abcn, true);
check("float64 NaN little endian transport", Number.isNaN(view.getFloat64(offset, true)));

const endianProbe = new Uint16Array([0x0102]);
const nativeLittleEndian = new Uint8Array(endianProbe.buffer)[0] === 0x02;

function typedNumberConsistency(name, ArrayType, setValue, getter, expected) {
	const typed = new ArrayType(1);
	typed[0] = setValue;
	const data = new DataView(typed.buffer);
	check(
		"typed array consistency " + name,
		sameNumber(typed[0], expected) &&
			sameNumber(data[getter](0, nativeLittleEndian), expected),
	);
}

typedNumberConsistency("int8", Int8Array, -2, "getInt8", -2);
typedNumberConsistency("uint8", Uint8Array, 0xa5, "getUint8", 0xa5);
typedNumberConsistency("int16", Int16Array, -0x1234, "getInt16", -0x1234);
typedNumberConsistency("uint16", Uint16Array, 0xabcd, "getUint16", 0xabcd);
typedNumberConsistency("int32", Int32Array, -0x01234567, "getInt32", -0x01234567);
typedNumberConsistency("uint32", Uint32Array, 0x89abcdef, "getUint32", 0x89abcdef);
typedNumberConsistency("float32 -0", Float32Array, -0, "getFloat32", -0);
typedNumberConsistency("float64 -0", Float64Array, -0, "getFloat64", -0);
typedNumberConsistency("float32 NaN", Float32Array, NaN, "getFloat32", NaN);
typedNumberConsistency("float64 NaN", Float64Array, NaN, "getFloat64", NaN);

const signedBig = new BigInt64Array(1);
signedBig[0] = -0x0123456789abcdefn;
check(
	"typed array consistency bigint64",
	new DataView(signedBig.buffer).getBigInt64(0, nativeLittleEndian) === signedBig[0],
);
const unsignedBig = new BigUint64Array(1);
unsignedBig[0] = 0x89abcdef01234567n;
check(
	"typed array consistency biguint64",
	new DataView(unsignedBig.buffer).getBigUint64(0, nativeLittleEndian) === unsignedBig[0],
);

const clamped = new Uint8ClampedArray([2.5, 3.5, -1, 300]);
check("typed array clamping remains semantic", String(clamped) === "2,4,0,255");

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
