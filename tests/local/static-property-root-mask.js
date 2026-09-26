const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("static-property-root-mask requires MAL_HOST_GC=1");
}

const checkpoints = [];

function checkpoint(value) {
	const holder = [value];
	checkpoints.push(holder);
	if (checkpoints.length > 16) checkpoints.length = 0;
	return holder;
}

function readValueThenSafepoint(receiver, survivor) {
	const value = receiver.value;
	const holder = checkpoint(survivor);
	if (holder[0] !== survivor || survivor.marker !== 42) {
		throw new Error("property-load survivor was lost");
	}
	return value;
}

function callFloorThenSafepoint(value, survivor) {
	const floor = Math.floor;
	const holder = checkpoint(survivor);
	if (holder[0] !== survivor || survivor.marker !== 42) {
		throw new Error("watched-load survivor was lost");
	}
	return floor(value);
}

const survivor = { marker: 42 };
const own = { value: 11 };
const prototype = { value: 13 };
const inherited = Object.create(prototype);
let checksum = 0;

for (let index = 0; index < 200; index++) {
	checksum += readValueThenSafepoint(own, survivor);
	checksum += readValueThenSafepoint(inherited, survivor);
}

for (let index = 0; index < 100; index++) {
	checksum += callFloorThenSafepoint(7.9, survivor);
}

let getterCalls = 0;
const accessor = {
	get value() {
		getterCalls++;
		return 15;
	},
};
checksum += readValueThenSafepoint(accessor, survivor);

let proxyCalls = 0;
const proxy = new Proxy(
	{ value: 17 },
	{
		get(target, key, receiver) {
			if (key === "value") proxyCalls++;
			return Reflect.get(target, key, receiver);
		},
	},
);
checksum += readValueThenSafepoint(proxy, survivor);

const originalFloor = Math.floor;
Math.floor = function () {
	return 19;
};
checksum += callFloorThenSafepoint(7.9, survivor);
Math.floor = originalFloor;
checksum += callFloorThenSafepoint(7.9, survivor);

if (checksum !== 5_558) throw new Error(`checksum ${checksum}`);
if (getterCalls !== 1) throw new Error(`getter calls ${getterCalls}`);
if (proxyCalls !== 1) throw new Error(`proxy calls ${proxyCalls}`);

function readPair(owner, trigger) {
	const first = owner.first;
	const second = trigger.second;
	return first.marker + second.marker;
}

const pairOwner = { first: { marker: 23 } };
const pairTrigger = { second: { marker: 29 } };
for (let index = 0; index < 32; index++) {
	if (readPair(pairOwner, pairTrigger) !== 52) {
		throw new Error("warm property pair mismatch");
	}
}
let collectingGetterCalls = 0;
const collectingTrigger = {
	get second() {
		collectingGetterCalls++;
		// The preceding load becomes the only remaining owner before collection.
		pairOwner.first = null;
		gc();
		return { marker: 31 };
	},
};
if (readPair(pairOwner, collectingTrigger) !== 54 || collectingGetterCalls !== 1) {
	throw new Error("incoming property root lost in collecting getter");
}

pairOwner.first = { marker: 83 };
const collectingProxyTrigger = new Proxy(
	{},
	{
		get(_target, key) {
			if (key !== "second") throw new Error("unexpected proxy trigger property");
			pairOwner.first = null;
			gc();
			return { marker: 89 };
		},
	},
);
if (readPair(pairOwner, collectingProxyTrigger) !== 172) {
	throw new Error("incoming property root lost in collecting proxy trap");
}

function recoverAfterThrow(owner) {
	const receiver = owner.first;
	try {
		return receiver.second;
	} catch (error) {
		gc();
		return receiver.marker + error.payload.marker;
	}
}

const throwingOwner = {
	first: {
		marker: 37,
		get second() {
			throwingOwner.first = null;
			const failure = { payload: { marker: 41 } };
			gc();
			throw failure;
		},
	},
};
if (recoverAfterThrow(throwingOwner) !== 78) {
	throw new Error("receiver or thrown heap value lost at catch continuation");
}

function readAfterCallback(owner, trigger) {
	const receiver = owner.first;
	const signal = trigger.second;
	const result = receiver.value;
	return result.marker + signal.marker;
}

const mutationOwner = { first: { value: { marker: 43 } } };
const mutationTrigger = { second: { marker: 47 } };
for (let index = 0; index < 32; index++) {
	if (readAfterCallback(mutationOwner, mutationTrigger) !== 90) {
		throw new Error("warm callback property mismatch");
	}
}
let replacementGetterCalls = 0;
const replacementPrototype = {
	get value() {
		replacementGetterCalls++;
		gc();
		return { marker: 53 };
	},
};
const mutatingTrigger = {
	get second() {
		const receiver = mutationOwner.first;
		delete receiver.value;
		Object.setPrototypeOf(receiver, replacementPrototype);
		mutationOwner.first = null;
		gc();
		return { marker: 59 };
	},
};
if (
	readAfterCallback(mutationOwner, mutatingTrigger) !== 112 ||
	replacementGetterCalls !== 1
) {
	throw new Error("callback mutation reused a stale property cache");
}

function heapResultAcrossPoll(receiver) {
	const result = receiver.value;
	gc();
	return result.marker;
}

function detachedHitAcrossPoll(receiver) {
	const result = receiver.value;
	receiver.value = null;
	gc();
	return result.marker;
}

for (let index = 0; index < 8; index++) {
	if (detachedHitAcrossPoll({ value: { marker: 61 } }) !== 61) {
		throw new Error("heap-valued cache hit lost at later collecting poll");
	}
}
const returningGetter = {
	get value() {
		gc();
		return { marker: 67 };
	},
};
if (heapResultAcrossPoll(returningGetter) !== 67) {
	throw new Error("heap-valued getter return lost at later collecting poll");
}

function readHeapChain(receiver) {
	const result = receiver.first.second.third;
	gc();
	return result.marker;
}

let chainedGetterCalls = 0;
const chainedGetters = {
	get first() {
		chainedGetterCalls++;
		gc();
		return {
			marker: 71,
			get second() {
				chainedGetterCalls++;
				gc();
				return {
					marker: this.marker,
					get third() {
						chainedGetterCalls++;
						gc();
						return { marker: this.marker };
					},
				};
			},
		};
	},
};
if (readHeapChain(chainedGetters) !== 71 || chainedGetterCalls !== 3) {
	throw new Error("intermediate heap-valued getter result was not continuously rooted");
}

let collectingProxyCalls = 0;
const returningProxy = new Proxy(
	{},
	{
		get(_target, key) {
			if (key !== "value") throw new Error("unexpected proxy property");
			collectingProxyCalls++;
			gc();
			return { marker: 73 };
		},
	},
);
if (heapResultAcrossPoll(returningProxy) !== 73 || collectingProxyCalls !== 1) {
	throw new Error("heap-valued proxy return lost at later collecting poll");
}

function retainWideValues(owner, trigger) {
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
	const signal = trigger.value;
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
		signal.marker
	);
}

const wideOwner = {};
for (let index = 0; index < 70; index++) {
	wideOwner["p" + index] = { marker: index };
}
const wideTrigger = { value: { marker: 79 } };
for (let index = 0; index < 2; index++) {
	if (retainWideValues(wideOwner, wideTrigger) !== 2_494) {
		throw new Error("wide property root warmup mismatch");
	}
}
const collectingWideTrigger = {
	get value() {
		for (let index = 0; index < 70; index++) {
			delete wideOwner["p" + index];
		}
		gc();
		return { marker: 79 };
	},
};
if (retainWideValues(wideOwner, collectingWideTrigger) !== 2_494) {
	throw new Error("property roots outside the root mask were not published");
}

let traversalOrder = 0;
let traversalFailure = null;

function retainThroughArrayTraversal(owner, values) {
	const retained = owner.value;
	let visited = 0;
	for (const value of values) {
		visited = visited * 10 + value.marker;
	}
	gc();
	traversalOrder = visited;
	return retained;
}

function retainThroughThrowingArrayTraversal(owner, values) {
	const retained = owner.value;
	let visited = 0;
	let failure = null;
	try {
		for (const value of values) {
			visited = visited * 10 + value.marker;
		}
	} catch (error) {
		failure = error;
		gc();
	}
	gc();
	traversalOrder = visited;
	traversalFailure = failure;
	return retained;
}

globalThis.staticPropertyArrayTraversals = [
	retainThroughArrayTraversal,
	retainThroughThrowingArrayTraversal,
];

const traversalOwner = { value: { marker: 151 } };
const denseTraversal = [{ marker: 1 }, { marker: 2 }, { marker: 3 }];
for (let index = 0; index < 16; index++) {
	const plain = retainThroughArrayTraversal(traversalOwner, denseTraversal);
	if (plain.marker !== 151 || traversalOrder !== 123) {
		throw new Error("dense array traversal warmup mismatch");
	}
	const caught = retainThroughThrowingArrayTraversal(traversalOwner, denseTraversal);
	if (caught.marker !== 151 || traversalOrder !== 123 || traversalFailure !== null) {
		throw new Error("dense array traversal warmup mismatch");
	}
}

traversalOwner.value = { marker: 157 };
let collectingIndexCalls = 0;
const sparseTraversal = [{ marker: 4 }, , { marker: 6 }];
Object.defineProperty(sparseTraversal, "1", {
	get() {
		collectingIndexCalls++;
		traversalOwner.value = null;
		gc();
		return { marker: 5 };
	},
});
const traversed = retainThroughArrayTraversal(traversalOwner, sparseTraversal);
gc();
if (traversed.marker !== 157 || traversalOrder !== 456 || collectingIndexCalls !== 1) {
	throw new Error("collecting array-index fallback lost roots or traversal order");
}

traversalOwner.value = { marker: 163 };
let throwingIndexCalls = 0;
const throwingTraversal = [{ marker: 7 }, , ,];
Object.defineProperty(throwingTraversal, "1", {
	get() {
		throwingIndexCalls++;
		traversalOwner.value = null;
		const failure = { payload: { marker: 167 } };
		gc();
		throw failure;
	},
});
Object.defineProperty(throwingTraversal, "2", {
	get() {
		throwingIndexCalls += 10;
		throw new Error("array traversal continued after a thrown index getter");
	},
});
const failedTraversal = retainThroughThrowingArrayTraversal(
	traversalOwner,
	throwingTraversal,
);
gc();
if (
	failedTraversal.marker !== 163 ||
	traversalFailure.payload.marker !== 167 ||
	traversalOrder !== 7 ||
	throwingIndexCalls !== 1
) {
	throw new Error("throwing array-index fallback lost roots or its catch continuation");
}

let setterObservation = 0;
let setterFailure = null;

function retainThroughSetter(owner, value) {
	const retained = owner.value;
	const receiver = owner.receiver;
	receiver.sink = value;
	gc();
	return retained;
}

function retainThroughThrowingSetter(owner, value) {
	const retained = owner.value;
	const receiver = owner.receiver;
	try {
		receiver.sink = value;
		setterFailure = null;
	} catch (error) {
		gc();
		setterFailure = error;
	}
	gc();
	return retained;
}

globalThis.staticPropertySetterCalls = [retainThroughSetter, retainThroughThrowingSetter];

const setterOwner = { value: { marker: 173 }, receiver: { sink: null } };
const ordinarySetterValue = { marker: 179 };
for (let index = 0; index < 16; index++) {
	const plain = retainThroughSetter(setterOwner, ordinarySetterValue);
	const caught = retainThroughThrowingSetter(setterOwner, ordinarySetterValue);
	if (
		plain.marker !== 173 ||
		caught.marker !== 173 ||
		setterOwner.receiver.sink !== ordinarySetterValue ||
		setterFailure !== null
	) {
		throw new Error("ordinary static property store warmup mismatch");
	}
}

setterOwner.value = { marker: 181 };
let collectingSetterCalls = 0;
Object.defineProperty(setterOwner.receiver, "sink", {
	set(value) {
		collectingSetterCalls++;
		setterOwner.value = null;
		setterOwner.receiver = null;
		gc();
		setterObservation = value.marker;
	},
});
const setterRetained = retainThroughSetter(setterOwner, { marker: 191 });
gc();
if (
	setterRetained.marker !== 181 ||
	setterObservation !== 191 ||
	collectingSetterCalls !== 1
) {
	throw new Error("collecting setter lost its preceding heap root or argument");
}

setterOwner.value = { marker: 193 };
setterOwner.receiver = { sink: null };
for (let index = 0; index < 8; index++) {
	const retained = retainThroughThrowingSetter(setterOwner, ordinarySetterValue);
	if (retained.marker !== 193 || setterOwner.receiver.sink !== ordinarySetterValue) {
		throw new Error("throwing static property store warmup mismatch");
	}
}
let throwingSetterCalls = 0;
Object.defineProperty(setterOwner.receiver, "sink", {
	set(value) {
		throwingSetterCalls++;
		setterOwner.value = null;
		setterOwner.receiver = null;
		const failure = { payload: value };
		gc();
		throw failure;
	},
});
const throwingSetterRetained = retainThroughThrowingSetter(setterOwner, { marker: 197 });
gc();
if (
	throwingSetterRetained.marker !== 193 ||
	setterFailure.payload.marker !== 197 ||
	throwingSetterCalls !== 1
) {
	throw new Error("throwing setter lost its preceding root or caught heap payload");
}

function retainThroughNumberCoercion(holder, operand) {
	gc();
	const retained = holder.value;
	const result = operand + 1;
	gc();
	return result + retained.marker;
}
function retainThroughStringCoercion(holder, operand) {
	gc();
	const retained = holder.value;
	const result = operand + 1;
	gc();
	return result + retained.marker;
}
function retainThroughThrowingCoercion(holder, operand) {
	gc();
	const retained = holder.value;
	try {
		return operand + 1;
	} catch (error) {
		gc();
		return retained.marker + error.marker;
	}
}
globalThis.rootCoercionReaders = [
	retainThroughNumberCoercion,
	retainThroughStringCoercion,
	retainThroughThrowingCoercion,
];
for (let index = 0; index < 16; index++) {
	const numberHolder = { value: { marker: 41 } };
	const numberOperand = {
		valueOf() {
			numberHolder.value = null;
			gc();
			return 17;
		},
	};
	if (globalThis.rootCoercionReaders[0](numberHolder, numberOperand) !== 59)
		throw new Error("coercion lost an earlier heap-valued root");
	const stringHolder = { value: { marker: 41 } };
	const stringOperand = {
		[Symbol.toPrimitive](hint) {
			if (hint !== "default") throw new Error("wrong coercion hint");
			stringHolder.value = null;
			gc();
			return "v";
		},
	};
	if (globalThis.rootCoercionReaders[1](stringHolder, stringOperand) !== "v141")
		throw new Error("coercion lost its heap-valued result or preceding root");
	const throwHolder = { value: { marker: 41 } };
	const throwOperand = {
		[Symbol.toPrimitive]() {
			throwHolder.value = null;
			gc();
			throw { marker: 23 };
		},
	};
	if (globalThis.rootCoercionReaders[2](throwHolder, throwOperand) !== 64)
		throw new Error("throwing coercion lost a catch root");
}

console.log("static-property-root-mask PASS");
