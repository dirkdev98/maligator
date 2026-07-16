// Broad residual shaped-object benchmark. Positive objects are frame-local but
// cannot be scalar-replaced because their type, identity, or prototype chain is
// observed. No positive object is passed, returned, captured, suspended, stored,
// thrown, or placed in another object. The bounded loops perform millions of
// fixed-key operations; the final phases are explicit heap-allocation controls.

const MOD = 1000000007;
const SHAPE_RUNS = 120000;

function observed1(seed) {
	const o = { f0: seed };
	let result = typeof o === "object" && o === o ? o.f0 : 0;
	if (typeof o === "object") result += 3;
	return result;
}

function observed4(seed) {
	const o = { f0: seed, f1: seed + 1, f2: seed + 2, f3: seed + 3 };
	if ((seed & 1) === 0) o.f2 = o.f0 + o.f3;
	else o.f2 = o.f1 + o.f2;
	let result = o.f0 + o.f1 + o.f2 + o.f3;
	if (typeof o !== "object") result = 0;
	return result;
}

function observed16(seed) {
	const o = {
		f0: seed,
		f1: seed + 1,
		f2: seed + 2,
		f3: seed + 3,
		f4: seed + 4,
		f5: seed + 5,
		f6: seed + 6,
		f7: seed + 7,
		f8: seed + 8,
		f9: seed + 9,
		f10: seed + 10,
		f11: seed + 11,
		f12: seed + 12,
		f13: seed + 13,
		f14: seed + 14,
		f15: seed + 15,
	};
	if ((seed & 2) === 0) o.f7 = o.f1 + o.f15;
	else o.f7 = o.f3 + o.f11;
	let result = o.f0 + o.f1 + o.f2 + o.f3 + o.f4 + o.f5 + o.f6 + o.f7;
	result += o.f8 + o.f9 + o.f10 + o.f11 + o.f12 + o.f13 + o.f14 + o.f15;
	if (o !== o) result = 0;
	return result;
}

function observed32(seed) {
	const o = {
		f0: seed,
		f1: seed + 1,
		f2: seed + 2,
		f3: seed + 3,
		f4: seed + 4,
		f5: seed + 5,
		f6: seed + 6,
		f7: seed + 7,
		f8: seed + 8,
		f9: seed + 9,
		f10: seed + 10,
		f11: seed + 11,
		f12: seed + 12,
		f13: seed + 13,
		f14: seed + 14,
		f15: seed + 15,
		f16: seed + 16,
		f17: seed + 17,
		f18: seed + 18,
		f19: seed + 19,
		f20: seed + 20,
		f21: seed + 21,
		f22: seed + 22,
		f23: seed + 23,
		f24: seed + 24,
		f25: seed + 25,
		f26: seed + 26,
		f27: seed + 27,
		f28: seed + 28,
		f29: seed + 29,
		f30: seed + 30,
		f31: seed + 31,
	};
	if ((seed & 4) === 0) o.f23 = o.f0 + o.f31;
	else o.f23 = o.f8 + o.f16;
	let result = o.f0 + o.f1 + o.f2 + o.f3 + o.f4 + o.f5 + o.f6 + o.f7;
	result += o.f8 + o.f9 + o.f10 + o.f11 + o.f12 + o.f13 + o.f14 + o.f15;
	result += o.f16 + o.f17 + o.f18 + o.f19 + o.f20 + o.f21 + o.f22 + o.f23;
	result += o.f24 + o.f25 + o.f26 + o.f27 + o.f28 + o.f29 + o.f30 + o.f31;
	if (typeof o !== "object") result = 0;
	return result;
}

function identityPair(seed) {
	const left = { x: seed, y: seed + 1, z: seed + 2, tag: 1 };
	const right = { x: seed + 3, y: seed + 4, z: seed + 5, tag: 2 };
	let result = left === left && right === right && left !== right ? left.x + right.y : 0;
	if (typeof left !== "object" || typeof right !== "object") result = 0;
	return result;
}

function unrelatedAllocation(seed) {
	const text = "noise:" + (seed & 255);
	const object = { text, value: seed, next: seed + 1, kind: 7 };
	if (typeof object.toString !== "function") return 0;
	return object.text.length + object.value + object.next;
}

function reentrant(depth, seed) {
	const o = { a: seed, b: seed + 1, c: seed + 2, d: seed + 3 };
	let nested;
	if (depth === 0) nested = unrelatedAllocation(seed);
	else nested = reentrant(depth - 1, seed + 5);
	if ((seed & 1) === 0) o.c = o.a + o.d;
	if (typeof o !== "object" || o !== o) return 0;
	return o.a + o.b + o.c + o.d + nested;
}

function heapValuedSlots(seed) {
	const text = "slot:" + (seed & 1023);
	const o = { text, mirror: text, value: seed, next: seed + 1 };
	const before = o.text.length;
	const noise = unrelatedAllocation(seed + 11);
	let result = before + o.mirror.length + o.value + o.next + noise;
	if (typeof o !== "object") result = 0;
	return result;
}

// Negative controls. These objects cross a frame or enter persistent storage and
// therefore must remain heap allocated even when positive objects gain a stack path.
let storedNegative = null;
let passedNegative = null;

function returnedNegative(depth, seed) {
	if (depth === 0) return { a: seed, b: seed + 1, c: seed + 2, d: seed + 3 };
	return returnedNegative(depth - 1, seed + 1);
}

function storeNegative(seed) {
	storedNegative = { a: seed, b: seed + 1, c: seed + 2, d: seed + 3 };
	return storedNegative.a + storedNegative.d;
}

function receiveNegative(object) {
	passedNegative = object;
	return object.b + object.c;
}

function passNegative(seed) {
	const object = { a: seed, b: seed + 1, c: seed + 2, d: seed + 3 };
	return receiveNegative(object);
}

let checksum = 0;
for (let i = 0; i < SHAPE_RUNS; i++) {
	checksum = (checksum + observed1(i)) % MOD;
	checksum = (checksum + observed4(i)) % MOD;
	checksum = (checksum + observed16(i)) % MOD;
	checksum = (checksum + observed32(i)) % MOD;
}
for (let i = 0; i < 150000; i++) checksum = (checksum + identityPair(i)) % MOD;
for (let i = 0; i < 100000; i++) {
	checksum = (checksum + reentrant(3, i)) % MOD;
	checksum = (checksum + heapValuedSlots(i)) % MOD;
}
for (let i = 0; i < 60000; i++) {
	const returned = returnedNegative(1, i);
	checksum = (checksum + returned.a + returned.d) % MOD;
	checksum = (checksum + storeNegative(i)) % MOD;
	checksum = (checksum + passNegative(i)) % MOD;
}

const EXPECTED_CHECKSUM = 597883230;
if (checksum !== EXPECTED_CHECKSUM) {
	throw new Error("stack-object checksum " + checksum + " expected " + EXPECTED_CHECKSUM);
}
console.log(checksum);
