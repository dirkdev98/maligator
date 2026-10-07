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

for (const factory of [own, accessor]) {
	for (let iteration = 0; iteration < 8; iteration++) {
		if (compactRoots(factory, visit) !== 51) throw new Error("disjoint root lost");
		for (const choose of [false, true])
			for (const fail of [false, true])
				if (branchRoots(factory, visit, choose, fail) !== (choose ? 60 : 66))
					throw new Error("join or catch root lost");
	}
}

let displacedTarget = own(11);
const displaced = new WeakRef(displacedTarget);

setTimeout(() => {
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
