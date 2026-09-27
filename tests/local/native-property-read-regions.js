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

function readGuardFallback(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readHandlerBoundary(receiver) {
	const first = receiver.first;
	try {
		const middle = receiver.middle;
		const last = receiver.last;
		const tail = receiver.tail;
		gc();
		return first.marker + middle.marker + last.marker + tail.marker;
	} catch (error) {
		gc();
		return first.marker + error.marker;
	}
}

function readInheritedStorageMutation(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readPublicOverflowShadow(receiver) {
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	gc();
	return first.marker + middle.marker + last.marker;
}

function readWideJoin(owner, receiver) {
	const held0 = owner.p0;
	const held1 = owner.p1;
	const held2 = owner.p2;
	const held3 = owner.p3;
	const held4 = owner.p4;
	const held5 = owner.p5;
	const held6 = owner.p6;
	const held7 = owner.p7;
	const held8 = owner.p8;
	const held9 = owner.p9;
	const held10 = owner.p10;
	const held11 = owner.p11;
	const held12 = owner.p12;
	const held13 = owner.p13;
	const held14 = owner.p14;
	const held15 = owner.p15;
	const held16 = owner.p16;
	const held17 = owner.p17;
	const held18 = owner.p18;
	const held19 = owner.p19;
	const held20 = owner.p20;
	const held21 = owner.p21;
	const held22 = owner.p22;
	const held23 = owner.p23;
	const held24 = owner.p24;
	const held25 = owner.p25;
	const held26 = owner.p26;
	const held27 = owner.p27;
	const held28 = owner.p28;
	const held29 = owner.p29;
	const held30 = owner.p30;
	const held31 = owner.p31;
	const held32 = owner.p32;
	const held33 = owner.p33;
	const held34 = owner.p34;
	const held35 = owner.p35;
	const held36 = owner.p36;
	const held37 = owner.p37;
	const held38 = owner.p38;
	const held39 = owner.p39;
	const held40 = owner.p40;
	const held41 = owner.p41;
	const held42 = owner.p42;
	const held43 = owner.p43;
	const held44 = owner.p44;
	const held45 = owner.p45;
	const held46 = owner.p46;
	const held47 = owner.p47;
	const held48 = owner.p48;
	const held49 = owner.p49;
	const held50 = owner.p50;
	const held51 = owner.p51;
	const held52 = owner.p52;
	const held53 = owner.p53;
	const held54 = owner.p54;
	const held55 = owner.p55;
	const held56 = owner.p56;
	const held57 = owner.p57;
	const held58 = owner.p58;
	const held59 = owner.p59;
	const held60 = owner.p60;
	const held61 = owner.p61;
	const held62 = owner.p62;
	const held63 = owner.p63;
	const held64 = owner.p64;
	const held65 = owner.p65;
	const held66 = owner.p66;
	const held67 = owner.p67;
	const held68 = owner.p68;
	const held69 = owner.p69;
	const first = receiver.first;
	const middle = receiver.middle;
	const last = receiver.last;
	for (let index = 0; index < 70; index++) {
		delete owner["p" + index];
	}
	delete receiver.first;
	delete receiver.middle;
	delete receiver.last;
	gc();
	return (
		held0.marker +
		held1.marker +
		held2.marker +
		held3.marker +
		held4.marker +
		held5.marker +
		held6.marker +
		held7.marker +
		held8.marker +
		held9.marker +
		held10.marker +
		held11.marker +
		held12.marker +
		held13.marker +
		held14.marker +
		held15.marker +
		held16.marker +
		held17.marker +
		held18.marker +
		held19.marker +
		held20.marker +
		held21.marker +
		held22.marker +
		held23.marker +
		held24.marker +
		held25.marker +
		held26.marker +
		held27.marker +
		held28.marker +
		held29.marker +
		held30.marker +
		held31.marker +
		held32.marker +
		held33.marker +
		held34.marker +
		held35.marker +
		held36.marker +
		held37.marker +
		held38.marker +
		held39.marker +
		held40.marker +
		held41.marker +
		held42.marker +
		held43.marker +
		held44.marker +
		held45.marker +
		held46.marker +
		held47.marker +
		held48.marker +
		held49.marker +
		held50.marker +
		held51.marker +
		held52.marker +
		held53.marker +
		held54.marker +
		held55.marker +
		held56.marker +
		held57.marker +
		held58.marker +
		held59.marker +
		held60.marker +
		held61.marker +
		held62.marker +
		held63.marker +
		held64.marker +
		held65.marker +
		held66.marker +
		held67.marker +
		held68.marker +
		held69.marker +
		first.marker +
		middle.marker +
		last.marker
	);
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
	readGuardFallback,
	readHandlerBoundary,
	readWideJoin,
	readInheritedStorageMutation,
	readPublicOverflowShadow,
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

for (const rejected of ["first", "middle", "last"]) {
	const receiver = {
		first: { marker: 2 },
		middle: { marker: 3 },
		last: { marker: 5 },
	};
	for (let index = 0; index < 8; index++) {
		expectValue(readGuardFallback(receiver), 10, "warm all-data region");
	}
	const events = [];
	Object.defineProperty(receiver, rejected, {
		configurable: true,
		get() {
			events.push(rejected);
			if (rejected === "first") {
				receiver.middle = { marker: 7 };
				receiver.last = { marker: 11 };
			} else if (rejected === "middle") {
				receiver.first = null;
				receiver.last = { marker: 11 };
			} else {
				receiver.first = null;
				receiver.middle = null;
			}
			gc();
			return { marker: rejected === "first" ? 2 : rejected === "middle" ? 3 : 5 };
		},
	});
	expectValue(
		readGuardFallback(receiver),
		rejected === "first" ? 20 : rejected === "middle" ? 16 : 10,
		rejected + " fallback keeps original reads and live values",
	);
	expectValue(events.join(","), rejected, rejected + " getter executes once");
}

const handlerOwn = {
	first: { marker: 2 },
	middle: { marker: 3 },
	last: { marker: 5 },
	tail: { marker: 0 },
};
for (let index = 0; index < 8; index++) {
	expectValue(readHandlerBoundary(handlerOwn), 10, "warm changing handler boundary");
}
let lastThrowCount = 0;
const lastThrowReceiver = {
	first: { marker: 2 },
	middle: { marker: 3 },
	get last() {
		lastThrowCount++;
		lastThrowReceiver.first = null;
		lastThrowReceiver.middle = null;
		gc();
		throw { marker: 17 };
	},
	tail: { marker: 0 },
};
expectValue(
	readHandlerBoundary(lastThrowReceiver),
	19,
	"throwing region load uses its original handler and preserves the earlier heap value",
);
expectValue(lastThrowCount, 1, "throwing region getter executes once");
let escapedMarker = 0;
const firstThrowReceiver = {
	get first() {
		gc();
		throw { marker: 23 };
	},
	get middle() {
		throw new Error("continued after throwing first load");
	},
	last: { marker: 5 },
};
try {
	readHandlerBoundary(firstThrowReceiver);
} catch (error) {
	escapedMarker = error.marker;
}
expectValue(escapedMarker, 23, "first load keeps the handler outside the region");

function makeWideOwner() {
	const owner = {};
	for (let index = 0; index < 70; index++) {
		owner["p" + index] = { marker: index };
	}
	return owner;
}

for (let index = 0; index < 3; index++) {
	expectValue(
		readWideJoin(makeWideOwner(), {
			first: { marker: 2 },
			middle: { marker: 3 },
			last: { marker: 5 },
		}),
		2425,
		"wide roots survive the collecting continuation after region hits",
	);
}
const wideFallbackOwner = makeWideOwner();
let wideGetterCalls = 0;
const wideFallbackReceiver = {
	first: { marker: 2 },
	get middle() {
		wideGetterCalls++;
		for (let index = 0; index < 70; index++) {
			delete wideFallbackOwner["p" + index];
		}
		wideFallbackReceiver.first = null;
		gc();
		return { marker: 3 };
	},
	last: { marker: 5 },
};
expectValue(
	readWideJoin(wideFallbackOwner, wideFallbackReceiver),
	2425,
	"wide roots survive a collecting getter and the common continuation",
);
expectValue(wideGetterCalls, 1, "wide-root fallback getter executes once");

// An inherited getter keeps the receiver shaped until the middle read declines.
let inheritedStorageArmed = false;
let inheritedStorageGetterCalls = 0;
const inheritedStoragePrototype = {
	get middle() {
		if (inheritedStorageArmed) {
			inheritedStorageGetterCalls++;
			inheritedStorageReceiver.first = null;
			// Public index insertion releases the two-property shaped slot buffer.
			inheritedStorageReceiver[0] = true;
			inheritedStorageReceiver.last = { marker: 11 };
			gc();
		}
		return { marker: 3 };
	},
};
const inheritedStorageReceiver = Object.create(inheritedStoragePrototype);
inheritedStorageReceiver.first = { marker: 2 };
inheritedStorageReceiver.last = { marker: 5 };
for (let index = 0; index < 16; index++) {
	expectValue(
		readInheritedStorageMutation(inheritedStorageReceiver),
		10,
		"warm shaped own hit before inherited getter",
	);
}
inheritedStorageArmed = true;
expectValue(
	readInheritedStorageMutation(inheritedStorageReceiver),
	16,
	"inherited getter invalidates captured slots and preserves the earlier heap value",
);
expectValue(inheritedStorageGetterCalls, 1, "inherited storage getter executes once");

const publicOverflowShadowPrototype = {
	first: { marker: 2 },
	middle: { marker: 3 },
	last: { marker: 5 },
};
const publicOverflowShadowReceiver = Object.create(publicOverflowShadowPrototype);
for (let index = 0; index < 16; index++) {
	expectValue(
		readPublicOverflowShadow(publicOverflowShadowReceiver),
		10,
		"warm inherited region on an empty-shaped receiver",
	);
}
// Public table entries preserve this empty shape, so inherited guards must reject them.
publicOverflowShadowReceiver[0] = true;
publicOverflowShadowReceiver.middle = { marker: 11 };
expectValue(
	readPublicOverflowShadow(publicOverflowShadowReceiver),
	18,
	"public overflow shadows an inherited cache value without changing the empty shape",
);

console.log("native-property-read-regions PASS");
