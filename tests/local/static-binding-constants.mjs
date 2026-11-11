// Module constants read by functions fold to literals only after their TDZ check.
function early() {
	return SCALE * 2;
}
let earlyError = "none";
try {
	early();
} catch (error) {
	earlyError = error instanceof ReferenceError ? "ReferenceError" : String(error);
}
const SCALE = 1.5;
const LIMIT = 1_000_000_007;
const WIDE = 4_294_967_296;
const ENABLED = true;
const NOTHING = null;
function scaled(value) {
	return value * SCALE;
}
function bounded(value) {
	return value % LIMIT;
}
function widened(value) {
	return value + WIDE;
}
function gated(value) {
	return ENABLED ? value : -value;
}
function absent() {
	return NOTHING === null;
}
function offsetBy(base) {
	return (value) => value + base * SCALE;
}
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const HUGE = 1n << 200n;
// BigInt constants fold too, so the hash loop's operands keep exact BigInt kinds.
function fnv1a64(bytes) {
	let hash = FNV_OFFSET;
	for (let index = 0; index < bytes.length; index++) {
		hash ^= BigInt(bytes[index]);
		hash = BigInt.asUintN(64, hash * FNV_PRIME);
	}
	return hash;
}
function hugeMix(value) {
	return (value * HUGE + FNV_PRIME) % (HUGE - 1n);
}
function convert(values) {
	const results = [];
	for (let index = 0; index < values.length; index++) {
		try {
			results.push(String(BigInt(values[index])));
		} catch (error) {
			results.push(error.name);
		}
	}
	return results.join(",");
}
let checksum = 0;
for (let index = 0; index < 1_000; index++) {
	checksum = (checksum + bounded(index * 7_919) + scaled(index)) % LIMIT;
}
console.log(
	earlyError,
	scaled(3),
	bounded(LIMIT + 5),
	widened(1),
	gated(4),
	absent(),
	offsetBy(2)(1),
	checksum,
	String(fnv1a64(new Uint8Array([0, 1, 127, 128, 255]))),
	String(hugeMix(3n)),
	convert([1, -0, 2 ** 60, 0.5, undefined, "7", true]),
);
