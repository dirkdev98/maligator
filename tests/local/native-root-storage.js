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

for (const factory of [own, accessor]) {
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
