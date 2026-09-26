const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("native-property-read-regions requires MAL_HOST_GC=1");
}

function expectValue(actual, expected, message) {
	if (actual !== expected) throw new Error(message + ": " + actual);
}

function readThree(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

// Separate cache sites keep each mutation warmup on its admitted receiver shape.
function readMixed(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readSameShape(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readInheritedMutation(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readPrototypeMutation(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readAccessorMutation(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readStorageMutation(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readProxy(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readDetachedOwn(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	receiver.first = null;
	receiver.middle = null;
	receiver.last = null;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readEight(receiver) {
	const a = receiver.a;
	const b = receiver.b;
	const c = receiver.c;
	const d = receiver.d;
	const e = receiver.e;
	const f = receiver.f;
	const g = receiver.g;
	const h = receiver.h;
	gc();
	return (
		a.marker + b.marker + c.marker + d.marker + e.marker + f.marker + g.marker + h.marker
	);
}

function readSeparated(receiver, seed) {
	const scalar = +seed;
	const first = receiver.first;
	const shifted = scalar + 1;
	const last = receiver.last;
	gc();
	return first.marker + last.marker + shifted;
}

function readThreeInTry(receiver) {
	try {
		const first = receiver.first;
		const middle = receiver.middle;
		const last = receiver.last;
		return first.marker + middle.marker + last.marker;
	} catch (error) {
		gc();
		return error.marker;
	}
}

globalThis.nativePropertyRegionReaders = [
	readMixed,
	readSameShape,
	readInheritedMutation,
	readPrototypeMutation,
	readAccessorMutation,
	readStorageMutation,
	readProxy,
	readThree,
	readEight,
	readDetachedOwn,
	readSeparated,
	readThreeInTry,
];

const own = {
	first: { marker: 2 },
	middle: { marker: 3 },
	last: { marker: 5 },
};
const eight = {
	a: { marker: 1 },
	b: { marker: 2 },
	c: { marker: 3 },
	d: { marker: 4 },
	e: { marker: 5 },
	f: { marker: 6 },
	g: { marker: 7 },
	h: { marker: 8 },
};
for (let index = 0; index < 32; index++) {
	expectValue(readThree(own), 10, "own data region");
	expectValue(readEight(eight), 36, "eight-load region");
	expectValue(
		readDetachedOwn({ first: { marker: 2 }, middle: { marker: 3 }, last: { marker: 5 } }),
		10,
		"detached heap-valued region hits at later collecting poll",
	);
	expectValue(readSeparated(own, index), 8 + index, "nonadjacent two-load region");
}

function makeMixed(prototype, marker) {
	const receiver = Object.create(prototype);
	receiver.first = { marker };
	return receiver;
}

const mixedA = makeMixed({ middle: { marker: 7 }, last: { marker: 11 } }, 5);
const mixedB = makeMixed({ middle: { marker: 17 }, last: { marker: 19 } }, 13);
for (let index = 0; index < 16; index++) {
	expectValue(readMixed(mixedA), 23, "mixed own and inherited data region");
}
for (let index = 0; index < 16; index++) {
	expectValue(readMixed(mixedB), 49, "distinct prototype data region");
}
for (let index = 0; index < 16; index++) {
	expectValue(readMixed(mixedA), 23, "equal-shape receiver with first prototype");
	expectValue(readMixed(mixedB), 49, "equal-shape receiver with second prototype");
}

let sameShapeArmed = false;
let sameShapeMutations = 0;
const sameShape = {
	first: { marker: 23 },
	get middle() {
		if (sameShapeArmed) {
			sameShapeMutations++;
			sameShape.first = null;
			sameShape.last = { marker: 37 };
			gc();
		}
		return { marker: 29 };
	},
	last: { marker: 31 },
};
for (let index = 0; index < 16; index++) {
	expectValue(readSameShape(sameShape), 83, "warm middle getter region");
}
sameShapeArmed = true;
expectValue(readSameShape(sameShape), 89, "same-shape write after middle getter decline");
expectValue(sameShapeMutations, 1, "middle getter was not replayed");

let inheritedArmed = false;
const inheritedPrototype = { last: { marker: 47 } };
const inherited = Object.create(inheritedPrototype);
inherited.first = { marker: 41 };
Object.defineProperty(inherited, "middle", {
	get() {
		if (inheritedArmed) {
			inherited.first = null;
			inheritedPrototype.last = { marker: 53 };
			gc();
		}
		return { marker: 43 };
	},
});
for (let index = 0; index < 16; index++) {
	expectValue(readInheritedMutation(inherited), 131, "warm inherited data continuation");
}
inheritedArmed = true;
expectValue(
	readInheritedMutation(inherited),
	137,
	"inherited value invalidated during getter",
);

let prototypeArmed = false;
const prototypeReceiver = Object.create({ last: { marker: 67 } });
prototypeReceiver.first = { marker: 59 };
const replacementPrototype = { last: { marker: 71 } };
Object.defineProperty(prototypeReceiver, "middle", {
	get() {
		if (prototypeArmed) {
			prototypeReceiver.first = null;
			Object.setPrototypeOf(prototypeReceiver, replacementPrototype);
			gc();
		}
		return { marker: 61 };
	},
});
for (let index = 0; index < 16; index++) {
	expectValue(
		readPrototypeMutation(prototypeReceiver),
		187,
		"warm prototype continuation",
	);
}
prototypeArmed = true;
expectValue(
	readPrototypeMutation(prototypeReceiver),
	191,
	"prototype replaced during middle getter",
);

let accessorArmed = false;
const accessorEvents = [];
const accessorReceiver = {
	first: { marker: 73 },
	get middle() {
		if (accessorArmed) {
			accessorEvents.push("middle");
			accessorReceiver.first = null;
			Object.defineProperty(accessorReceiver, "last", {
				get() {
					accessorEvents.push("last");
					gc();
					return { marker: 89 };
				},
			});
			gc();
		}
		return { marker: 79 };
	},
	last: { marker: 83 },
};
for (let index = 0; index < 16; index++) {
	expectValue(readAccessorMutation(accessorReceiver), 235, "warm own slot continuation");
}
accessorArmed = true;
expectValue(
	readAccessorMutation(accessorReceiver),
	241,
	"later data slot converted to accessor",
);
expectValue(accessorEvents.join(","), "middle,last", "accessor continuation order");

let growthArmed = false;
const growthReceiver = {
	first: { marker: 97 },
	get middle() {
		if (growthArmed) {
			growthReceiver.first = null;
			for (let index = 0; index < 24; index++) {
				growthReceiver["added" + index] = { marker: index };
			}
			growthReceiver.last = { marker: 107 };
			gc();
		}
		return { marker: 101 };
	},
	last: { marker: 103 },
};
for (let index = 0; index < 16; index++) {
	expectValue(readStorageMutation(growthReceiver), 301, "warm storage continuation");
}
growthArmed = true;
expectValue(
	readStorageMutation(growthReceiver),
	305,
	"slot storage grows during middle getter",
);

let throwArmed = false;
const throwingReceiver = {
	first: { marker: 109 },
	get middle() {
		if (throwArmed) {
			throwingReceiver.first = null;
			const error = { marker: 127 };
			gc();
			throw error;
		}
		return { marker: 113 };
	},
	get last() {
		if (throwArmed) throw new Error("continued after throwing region load");
		return { marker: 127 };
	},
};
for (let index = 0; index < 16; index++) {
	expectValue(readThreeInTry(throwingReceiver), 349, "warm throwing region");
}
throwArmed = true;
expectValue(
	readThreeInTry(throwingReceiver),
	127,
	"original region throw handler and live roots",
);

let proxyArmed = false;
const proxyEvents = [];
const proxyTarget = {
	first: { marker: 131 },
	middle: { marker: 137 },
	last: { marker: 139 },
};
const proxy = new Proxy(proxyTarget, {
	get(target, key, receiver) {
		if (receiver !== proxy) throw new Error("Proxy continuation changed the receiver");
		proxyEvents.push(key);
		if (key === "middle" && proxyArmed) {
			target.first = null;
			target.last = { marker: 149 };
			gc();
		}
		return Reflect.get(target, key, receiver);
	},
});
for (let index = 0; index < 8; index++) {
	expectValue(readProxy(proxy), 407, "warm Proxy continuation");
}
proxyEvents.length = 0;
proxyArmed = true;
expectValue(readProxy(proxy), 417, "Proxy mutation and heap-valued earlier result");
expectValue(proxyEvents.join(","), "first,middle,last", "Proxy continuation order");

console.log("native-property-read-regions PASS");
