const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function")
	throw new Error("native-root-storage requires MAL_HOST_GC=1");

function compactRoots(factory, visit) {
	const first = factory(11);
	const firstMarker = visit(first);
	const second = factory(17);
	const secondMarker = visit(second);
	const third = factory(23);
	return firstMarker + secondMarker + visit(third);
}

function branchRoots(factory, visit, choose, fail) {
	const first = factory(29);
	const firstMarker = visit(first);
	let retained;
	if (choose) retained = factory(31);
	else retained = factory(37);
	try {
		const marker = visit(retained);
		if (fail) throw retained;
		gc();
		return firstMarker + marker;
	} catch (error) {
		gc();
		return firstMarker + visit(error);
	}
}

function own(value) {
	return { marker: value };
}

function accessor(value) {
	return {
		get marker() {
			gc();
			return value;
		},
	};
}

function visit(value) {
	gc();
	return value.marker;
}

function continuationRoots(factory, collect, fail) {
	const held = factory(41);
	collect();
	try {
		collect();
		if (fail) throw held;
		return held.marker;
	} catch (error) {
		collect();
		return error.marker;
	}
}

function forwardBranchRoots(factory, collect, holder, choose) {
	const held = factory(43);
	collect(held);
	const second = holder.item;
	if (choose) {
		collect(held, second);
		return held.marker + second.marker;
	}
	const replacement = factory(47);
	collect(replacement, second);
	return replacement.marker + second.marker;
}

function unpublishedBranchRoots(factory, collect, holder, choose) {
	const held = factory(43);
	const second = holder.item;
	if (choose) {
		collect(held, second);
		return held.marker + second.marker;
	}
	collect(held, second);
	return held.marker + second.marker;
}

// More live probe results than one deferred miss path publishes.
function longProbeChain(holder) {
	const a0 = holder.p0;
	const a1 = holder.p1;
	const a2 = holder.p2;
	const a3 = holder.p3;
	const a4 = holder.p4;
	const a5 = holder.p5;
	const a6 = holder.p6;
	const a7 = holder.p7;
	const a8 = holder.p8;
	const a9 = holder.p9;
	const a10 = holder.p10;
	const a11 = holder.p11;
	return (
		a0.marker +
		a1.marker +
		a2.marker +
		a3.marker +
		a4.marker +
		a5.marker +
		a6.marker +
		a7.marker +
		a8.marker +
		a9.marker +
		a10.marker +
		a11.marker
	);
}

function probeHolder(factory, collecting) {
	const holder = {};
	for (let index = 0; index < 12; index++) {
		if (collecting)
			Object.defineProperty(holder, `p${index}`, {
				get() {
					gc();
					return factory(index + 1);
				},
			});
		else holder[`p${index}`] = factory(index + 1);
	}
	return holder;
}

for (const factory of [own, accessor]) {
	for (const collecting of [false, true])
		for (let iteration = 0; iteration < 4; iteration++)
			if (longProbeChain(probeHolder(factory, collecting)) !== 78)
				throw new Error("long probe chain root lost");
	for (let iteration = 0; iteration < 8; iteration++) {
		if (compactRoots(factory, visit) !== 51) throw new Error("disjoint root lost");
		for (const fail of [false, true])
			if (continuationRoots(factory, gc, fail) !== 41)
				throw new Error("continuation root lost");
		for (const choose of [
			false,
			true,
			{
				valueOf() {
					throw new Error("truthiness coerced an object");
				},
			},
		]) {
			const holder = () => ({
				value: factory(53),
				get item() {
					const result = this.value;
					this.value = null;
					gc();
					return result;
				},
			});
			if (forwardBranchRoots(factory, gc, holder(), choose) !== (choose ? 96 : 100))
				throw new Error("forward branch root lost");
			if (unpublishedBranchRoots(factory, gc, holder(), choose) !== 96)
				throw new Error("unpublished branch root lost");
		}
		for (const choose of [false, true])
			for (const fail of [false, true])
				if (branchRoots(factory, visit, choose, fail) !== (choose ? 60 : 66))
					throw new Error("join or catch root lost");
	}
}

function primitivePhiRoots(flag, collect) {
	const value = flag ? true : null;
	collect();
	return value;
}

function literalPhiRoots(flag, collect) {
	const value = flag ? "left" : "right";
	collect();
	return value;
}

function bigIntPhiRoots(flag, collect) {
	const value = flag ? 12345678901234567890n : 9876543210987654321n;
	collect();
	return value;
}

function cyclePhiRoots(count, collect) {
	let left = true;
	let right = null;
	for (let index = 0; index < (count | 0); index++) {
		collect();
		const old = left;
		left = right;
		right = old;
	}
	collect();
	return left;
}

function mixedPhiRoots(factory, count, collect) {
	let left = true;
	let right = factory();
	for (let index = 0; index < (count | 0); index++) {
		collect();
		const old = left;
		left = right;
		right = old;
	}
	collect();
	return left;
}

function freshPhiRoots(flag, factory, collect) {
	const value = flag ? factory() : null;
	collect();
	return value;
}

function* suspendedPhiRoots(factory, collect) {
	const value = factory();
	yield true;
	collect();
	return value;
}

globalThis.primitivePhiRoots = primitivePhiRoots;
globalThis.literalPhiRoots = literalPhiRoots;
globalThis.bigIntPhiRoots = bigIntPhiRoots;
globalThis.cyclePhiRoots = cyclePhiRoots;
globalThis.mixedPhiRoots = mixedPhiRoots;
globalThis.freshPhiRoots = freshPhiRoots;
globalThis.suspendedPhiRoots = suspendedPhiRoots;
let textSequence = 0;
function freshText() {
	return "fresh:" + textSequence++;
}
for (const flag of [true, false]) {
	if (globalThis.primitivePhiRoots(flag, gc) !== (flag ? true : null))
		throw new Error("primitive phi changed");
	if (globalThis.literalPhiRoots(flag, gc) !== (flag ? "left" : "right"))
		throw new Error("literal phi changed");
	if (
		globalThis.bigIntPhiRoots(flag, gc) !==
		(flag ? 12345678901234567890n : 9876543210987654321n)
	)
		throw new Error("BigInt literal phi changed");
	const expectedText = flag ? "fresh:" + textSequence : null;
	if (globalThis.freshPhiRoots(flag, freshText, gc) !== expectedText)
		throw new Error("fresh phi root lost");
}
let bigIntSequence = 0;
const freshBigInt = () => BigInt("1234567890123456789" + bigIntSequence++);
for (let index = 0; index < 4; index++) {
	const expected = BigInt("1234567890123456789" + bigIntSequence);
	if (globalThis.freshPhiRoots(true, freshBigInt, gc) !== expected)
		throw new Error("fresh BigInt phi root lost");
	const symbol = globalThis.freshPhiRoots(true, () => Symbol("phi:" + index), gc);
	if (String(symbol) !== "Symbol(phi:" + index + ")")
		throw new Error("fresh Symbol phi root lost");
}
for (const count of [0, 1, 2, 3, 8, 9]) {
	if (globalThis.cyclePhiRoots(count, gc) !== (count % 2 === 0 ? true : null))
		throw new Error("primitive copy cycle changed");
	const mixed = globalThis.mixedPhiRoots(() => own(67), count, gc);
	if (count % 2 === 0 ? mixed !== true : mixed.marker !== 67)
		throw new Error("managed copy cycle root lost");
	const suspended = globalThis.suspendedPhiRoots(() => own(71), gc);
	if (suspended.next().value !== true) throw new Error("suspended phi yield changed");
	gc();
	const resumed = suspended.next();
	if (!resumed.done || resumed.value.marker !== 71)
		throw new Error("suspended phi root lost");
}

let displacedTarget = own(11);
const displaced = new WeakRef(displacedTarget);
let transportedTarget = own(11);
const transportedWeak = new WeakRef(transportedTarget);

const exactTransfer = function exactTransfer(value) {
	let marker = value;
	for (let index = 0; index < 24; index++) marker += 0;
	if (value !== 11) {
		gc();
		return own(marker);
	}
	const object = transportedTarget;
	transportedTarget = null;
	gc();
	return object;
};

function transportedRelease() {
	const first = exactTransfer(11);
	const marker = first.marker;
	const second = exactTransfer(17);
	gc();
	if (transportedWeak.deref() !== undefined) throw new Error("transported root retained");
	return marker + second.marker;
}

setTimeout(() => {
	if (transportedRelease() !== 28) throw new Error("transported replacement lost");
	function transfer(value) {
		if (value !== 11) return own(value);
		const object = displacedTarget;
		displacedTarget = null;
		return object;
	}
	function verifyRelease(object) {
		if (object.marker !== 11) {
			gc();
			if (displaced.deref() !== undefined) throw new Error("displaced root retained");
		}
		return object.marker;
	}
	if (compactRoots(transfer, verifyRelease) !== 51)
		throw new Error("replacement root lost");
	console.log("native-root-storage PASS");
}, 0);
