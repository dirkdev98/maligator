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

check("loop reuse", loopReuse());
check("simultaneous stack sites", simultaneous(41));
check("recursion and reentrancy", recursive(6) === 70);
check("branch normal", branchAndException(false) === 21);
check("branch exception", branchAndException(true) === 28);

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

// Prototype-observing calls intentionally remain negative: passing the pointer to
// Object.getPrototypeOf is outside the first stack-object proof.
const prototypeNegative = returnEscape(15);
check(
	"ordinary object prototype",
	Object.getPrototypeOf(prototypeNegative) === Object.prototype,
);

if (failed !== 0) throw new Error("stack-object failures: " + failed);
console.log("stack-object PASS " + passed + "/" + passed);
