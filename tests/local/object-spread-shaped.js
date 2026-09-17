"use strict";

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("object-spread-shaped requires MAL_HOST_GC=1");
}

let passed = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

const shared = { marker: 17 };
const shapedSource = {
	kind: 7,
	flags: 3,
	generation: 11,
	block: 13,
	value: shared,
};
for (let index = 0; index < 32; index++) {
	const copy = { ...shapedSource };
	check(
		"shaped shallow copy " + index,
		Object.keys(copy).join(",") === "kind,flags,generation,block,value" &&
			copy.value === shared &&
			copy !== shapedSource,
	);
	copy.kind = index;
	check("copy remains independent " + index, shapedSource.kind === 7);
}

const overwritten = { ...shapedSource, value: 29, next: 31 };
check(
	"overwrite and append",
	Object.keys(overwritten).join(",") === "kind,flags,generation,block,value,next" &&
		overwritten.value === 29 &&
		overwritten.next === 31,
);

const nullSource = Object.create(null);
nullSource.alpha = 1;
nullSource.beta = 2;
const nullCopy = { ...nullSource };
check(
	"null source prototype",
	Object.getPrototypeOf(nullCopy) === Object.prototype &&
		nullCopy.alpha === 1 &&
		nullCopy.beta === 2,
);

let setterCalls = 0;
Object.defineProperty(Object.prototype, "shadowed", {
	configurable: true,
	set() {
		setterCalls++;
	},
});
try {
	const setterCopy = { ...{ shadowed: 41 } };
	check(
		"inherited setter bypass",
		setterCalls === 0 &&
			Object.hasOwn(setterCopy, "shadowed") &&
			setterCopy.shadowed === 41,
	);
} finally {
	delete Object.prototype.shadowed;
}

const protoValue = { marker: 43 };
const protoCopy = { ...{ ["__proto__"]: protoValue } };
check(
	"__proto__ remains data",
	Object.getPrototypeOf(protoCopy) === Object.prototype &&
		Object.hasOwn(protoCopy, "__proto__") &&
		protoCopy.__proto__ === protoValue,
);

const frozenCopy = { ...Object.freeze({ frozen: 47 }) };
const frozenDescriptor = Object.getOwnPropertyDescriptor(frozenCopy, "frozen");
check(
	"frozen source fallback",
	frozenCopy.frozen === 47 &&
		frozenDescriptor.writable === true &&
		frozenDescriptor.enumerable === true &&
		frozenDescriptor.configurable === true,
);

const symbol = Symbol("spread");
let getterCalls = 0;
const descriptorSource = { 0: "zero", plain: "plain", [symbol]: "symbol" };
Object.defineProperty(descriptorSource, "observed", {
	enumerable: true,
	get() {
		getterCalls++;
		return "getter";
	},
});
Object.defineProperty(descriptorSource, "hidden", {
	enumerable: false,
	value: "hidden",
});
const descriptorCopy = { ...descriptorSource };
check(
	"descriptor fallback",
	getterCalls === 1 &&
		descriptorCopy[0] === "zero" &&
		descriptorCopy.plain === "plain" &&
		descriptorCopy.observed === "getter" &&
		descriptorCopy[symbol] === "symbol" &&
		!("hidden" in descriptorCopy),
);

const thrown = new Error("spread getter");
const throwingSource = {};
Object.defineProperty(throwingSource, "value", {
	enumerable: true,
	get() {
		throw thrown;
	},
});
let caught;
try {
	({ ...throwingSource });
} catch (error) {
	caught = error;
}
check("throwing getter fallback", caught === thrown);

const nonempty = { prefix: 53, ...shapedSource };
check("nonempty target fallback", nonempty.prefix === 53 && nonempty.value === shared);

const wideSource = {};
for (let index = 0; index < 40; index++) wideSource["field-" + index] = index;
const wideCopy = { ...wideSource };
check(
	"wide fallback",
	Object.keys(wideCopy).length === 40 &&
		wideCopy["field-0"] === 0 &&
		wideCopy["field-39"] === 39,
);

function makeSourceAfterGc() {
	gc();
	return { left: { value: 59 }, right: { value: 61 } };
}
const barrierCopy = { ...makeSourceAfterGc() };
gc();
check(
	"old target retains young values",
	barrierCopy.left.value === 59 && barrierCopy.right.value === 61,
);

console.log("object-spread-shaped PASS " + passed + "/" + passed);
