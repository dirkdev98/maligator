let passed = 0;
let failed = 0;

function check(name, condition) {
	if (condition) passed++;
	else {
		failed++;
		console.log("FAIL: " + name);
	}
}

function allocateNoise(seed) {
	let text = "noise:" + seed;
	for (let i = 0; i < 20; i++) text = text + ":" + i;
	return text.length;
}

function loopReuse() {
	let total = 0;
	let distinct = true;
	for (let i = 0; i < 400; i++) {
		const o = { value: i, next: i + 1 };
		o.next = o.value + 2;
		distinct = distinct && o === o && typeof o === "object";
		total += o.value + o.next;
	}
	return distinct && total === 160400;
}

function emptyObserved(seed) {
	const o = {};
	allocateNoise(seed);
	return typeof o === "object" && o === o;
}

function simultaneous(seed) {
	const left = { value: seed, tag: "left:" + seed };
	const right = { value: seed + 1, tag: "right:" + seed };
	allocateNoise(seed);
	return (
		left !== right &&
		left === left &&
		right === right &&
		typeof left === "object" &&
		left.value + right.value === seed * 2 + 1 &&
		left.tag.length > 4 &&
		right.tag.length > 5
	);
}

function foldedObservations(seed) {
	const left = { value: seed };
	const alias = left;
	const right = { value: seed + 1 };
	return (
		typeof alias === "object" &&
		left === alias &&
		left !== right &&
		(left === right) === false &&
		left.value + right.value === seed * 2 + 1
	);
}

function foldedTypeof() {
	const object = {};
	return typeof object;
}

function scalarInitializerOrder(seed) {
	let current = seed;
	const order = [];
	const object = {
		kept: (order.push("kept"), current),
		unread: (order.push("unread"), (current = 99)),
	};
	return object.kept === seed && current === 99 && order.join(",") === "kept,unread";
}

function mutableScalarAlias(flag) {
	const object = { value: 1 };
	const alias = object;
	if (flag) alias.value = 9;
	return object.value;
}

function scalarBranchJoin(flag) {
	const object = { value: 0 };
	if (flag) object.value = 51;
	else object.value = 52;
	return object.value;
}

function scalarOperandRootedObject(value) {
	const point = { x: value, y: value + 1 };
	point.x = point.x + point.y;
	return point.x;
}

function homogeneousBooleanCell(flag, count) {
	const object = { value: true };
	for (let i = 0; i < count; i++) {
		if (flag) object.value = true;
		else object.value = false;
	}
	return object.value;
}

function mixedCellJoin(flag, count) {
	const object = { value: true };
	for (let i = 0; i < count; i++) {
		if (flag) object.value = false;
		else object.value = 1;
	}
	return object.value;
}

function materializedBooleanCell(flag) {
	const object = { value: true };
	if (flag) object.value = false;
	return object;
}

function recursive(depth) {
	const o = { depth, text: "depth:" + depth };
	const nested = depth === 0 ? 0 : recursive(depth - 1);
	allocateNoise(depth + 100);
	return typeof o === "object" && o === o ? nested + o.depth + o.text.length : -1000;
}

function branchAndException(takeThrow) {
	const o = { value: 7, text: "branch-value" };
	let caught = 0;
	try {
		allocateNoise(200);
		if (takeThrow) throw new Error("unrelated");
		o.value = 9;
	} catch (error) {
		caught = error.message.length;
	}
	allocateNoise(201);
	return typeof o === "object" && o === o ? o.value + o.text.length + caught : -1;
}

function conditionalReturn(seed, escape) {
	const o = { value: seed, text: "partial:" + seed };
	const alias = o;
	alias.value = seed + 2;
	allocateNoise(seed + 220);
	if (escape) return alias;
	return typeof o === "object" && o === alias ? alias.value + alias.text.length : -1;
}

function failConditionalReturn(escape) {
	__mal_fail_next_cell_allocation();
	const o = { value: 31, text: "oom-current" };
	if (escape) return o;
	return typeof o === "object" ? o.value : 0;
}

let globalEscape;
function returnEscape(seed) {
	return { value: seed, text: "return:" + seed };
}
function globalStoreEscape(seed) {
	globalEscape = { value: seed, text: "global:" + seed };
}
function captureEscape(seed) {
	const o = { value: seed, text: "capture:" + seed };
	return function () {
		return o.value + o.text.length;
	};
}
function receiveEscape(o) {
	globalEscape = o;
}
function callEscape(seed) {
	const o = { value: seed, text: "call:" + seed };
	receiveEscape(o);
}

function mixedJoinEscape(seed, useObject) {
	let result = seed;
	if (useObject) result = { value: seed, text: "mixed:" + seed };
	return result;
}

let inheritedIslandCaptured = null;
function inheritedIsland(seed, expected) {
	const object = { value: seed, next: seed + 1, tag: 17 };
	const inherited = object.toString;
	const capturedIdentity = object === inheritedIslandCaptured;
	if (inherited !== expected) return -1;
	return object.value + object.next + object.tag + (capturedIdentity ? 1000 : 0);
}

function replacementToString() {
	return "replacement";
}

const inheritedIslandFunctions = [inheritedIsland];
function callInheritedIsland(seed, expected) {
	return inheritedIslandFunctions[0](seed, expected);
}

check("loop reuse", loopReuse());
check("empty observed object", emptyObserved(40));
check("simultaneous stack sites", simultaneous(41));
check("folded object observations", foldedObservations(42));
check("folded standalone typeof", foldedTypeof() === "object");
check("scalar initializer order", scalarInitializerOrder(43));
check(
	"mutable scalar alias branch",
	mutableScalarAlias(false) === 1 && mutableScalarAlias(true) === 9,
);
check(
	"scalar branch join",
	scalarBranchJoin(true) === 51 && scalarBranchJoin(false) === 52,
);
const coercibleScalarOperand = {
	coercions: 0,
	valueOf() {
		this.coercions++;
		allocateNoise(430 + this.coercions);
		return 4;
	},
};
check(
	"operand-rooted boxed scalar replacement",
	scalarOperandRootedObject(coercibleScalarOperand) === 9 &&
		coercibleScalarOperand.coercions === 2,
);
check(
	"homogeneous boolean stack cell",
	homogeneousBooleanCell(true, 2) === true && homogeneousBooleanCell(false, 2) === false,
);
check(
	"mixed stack cell join",
	mixedCellJoin(true, 2) === false && mixedCellJoin(false, 2) === 1,
);
const materializedBoolean = materializedBooleanCell(true);
check(
	"materialized boolean stack cell",
	materializedBoolean.value === false &&
		Object.getPrototypeOf(materializedBoolean) === Object.prototype,
);
check("recursion and reentrancy", recursive(6) === 70);
check("branch normal", branchAndException(false) === 21);
check("branch exception", branchAndException(true) === 28);

check("partial nonescaping edge", conditionalReturn(20, false) === 32);
const partial = conditionalReturn(21, true);
const partialAgain = conditionalReturn(21, true);
allocateNoise(250);
check(
	"partial return current state and prototype",
	partial.value === 23 &&
		partial.text === "partial:21" &&
		Object.getPrototypeOf(partial) === Object.prototype,
);
check(
	"partial return identity",
	partial !== partialAgain && partial.value === partial.value,
);
partial.value = 99;
check(
	"partial return independent storage",
	partial.value === 99 && partialAgain.value === 23,
);

if (typeof __mal_fail_next_cell_allocation === "function") {
	let materializeOom = false;
	try {
		failConditionalReturn(true);
	} catch (error) {
		materializeOom = error instanceof Error;
	}
	check("partial return allocation failure", materializeOom);
}
const recoveredPartial = conditionalReturn(22, true);
check("partial return allocation recovery", recoveredPartial.value === 24);

const returned = returnEscape(11);
allocateNoise(300);
check(
	"returned object stays heap-live",
	returned.value === 11 && returned.text === "return:11",
);
globalStoreEscape(12);
allocateNoise(301);
check(
	"global object stays heap-live",
	globalEscape.value === 12 && globalEscape.text === "global:12",
);
const closure = captureEscape(13);
allocateNoise(302);
check("captured object stays heap-live", closure() === 23);
callEscape(14);
allocateNoise(303);
check(
	"passed object stays heap-live",
	globalEscape.value === 14 && globalEscape.text === "call:14",
);
const mixedJoin = mixedJoinEscape(16, true);
allocateNoise(305);
check(
	"mixed join object stays heap-live",
	mixedJoin.value === 16 && mixedJoin.text === "mixed:16",
);
check("mixed join scalar stays scalar", mixedJoinEscape(17, false) === 17);

const toStringDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toString");
const originalToString = toStringDescriptor.value;
check("inherited island cold fill", callInheritedIsland(30, originalToString) === 78);
check("inherited island stable fast", callInheritedIsland(31, originalToString) === 80);

Object.prototype.toString = replacementToString;
check(
	"inherited island data replacement cold",
	callInheritedIsland(32, replacementToString) === 82,
);
check(
	"inherited island data replacement fast",
	callInheritedIsland(33, replacementToString) === 84,
);

Object.defineProperty(Object.prototype, "toString", {
	configurable: true,
	enumerable: toStringDescriptor.enumerable,
	get() {
		inheritedIslandCaptured = this;
		delete this.value;
		this.value = 41;
		return replacementToString;
	},
});
check(
	"inherited island getter result and identity",
	callInheritedIsland(34, replacementToString) === 1093,
);
allocateNoise(304);
check(
	"inherited island getter captures heap receiver",
	inheritedIslandCaptured.value === 41 &&
		inheritedIslandCaptured.next === 35 &&
		inheritedIslandCaptured.tag === 17,
);

delete Object.prototype.toString;
inheritedIslandCaptured = null;
check("inherited island delete", callInheritedIsland(35, undefined) === 88);
Object.defineProperty(Object.prototype, "toString", {
	configurable: true,
	enumerable: toStringDescriptor.enumerable,
	value: originalToString,
	writable: true,
});
check("inherited island redefine cold", callInheritedIsland(36, originalToString) === 90);
check("inherited island redefine fast", callInheritedIsland(37, originalToString) === 92);
Object.defineProperty(Object.prototype, "toString", toStringDescriptor);

// Prototype-observing calls intentionally remain negative: passing the pointer to
// Object.getPrototypeOf is outside the first stack-object proof.
const prototypeNegative = returnEscape(15);
check(
	"ordinary object prototype",
	Object.getPrototypeOf(prototypeNegative) === Object.prototype,
);

if (failed !== 0) throw new Error("stack-object failures: " + failed);
console.log("stack-object PASS " + passed + "/" + passed);
