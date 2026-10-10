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
);
