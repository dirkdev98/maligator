function check(label, actual, expected) {
	if (!Object.is(actual, expected))
		throw new Error(label + ": " + actual + " !== " + expected);
}

function make(seed) {
	let bias = seed;
	const project = (x) =>
		x * 1 +
		bias +
		(x * 2 + bias) +
		(x * 3 + bias) +
		(x * 4 + bias) +
		(x * 5 + bias) +
		(x * 6 + bias) +
		(x * 7 + bias) +
		(x * 8 + bias) +
		(x * 9 + bias) +
		(x * 10 + bias) +
		(x * 11 + bias) +
		(x * 12 + bias) +
		(x * 13 + bias) +
		(x * 14 + bias) +
		(x * 15 + bias) +
		(x * 16 + bias) +
		(x * 17 + bias) +
		(x * 18 + bias) +
		(x * 19 + bias) +
		(x * 20 + bias);
	globalThis.escapedProjection = project;
	project.marker = seed;
	let total = 0;
	for (let i = 0; i < 20; i++) {
		bias = seed + i;
		total += project(i);
	}
	check("private calls see current bindings", total, 210 * 190 + 20 * (20 * seed + 190));
	check("unchanged function identity", globalThis.escapedProjection, project);
	check("unchanged source arity", project.length, 1);
	check("unchanged name", project.name, "project");
	check("unchanged function properties", project.marker, seed);
	check("extra arguments stay generic", project(2, 123), 420 + 20 * bias);
	check("missing arguments stay generic", Number.isNaN(project()), true);
	bias += 10;
	check(
		"capture is taken after argument evaluation",
		project((bias++, 3)),
		630 + 20 * bias,
	);
	return { project, bias };
}
function makeDeclared(seed) {
	let bias = seed;
	function project(x) {
		return (
			x * 1 +
			bias +
			(x * 2 + bias) +
			(x * 3 + bias) +
			(x * 4 + bias) +
			(x * 5 + bias) +
			(x * 6 + bias) +
			(x * 7 + bias) +
			(x * 8 + bias) +
			(x * 9 + bias) +
			(x * 10 + bias) +
			(x * 11 + bias) +
			(x * 12 + bias) +
			(x * 13 + bias) +
			(x * 14 + bias) +
			(x * 15 + bias) +
			(x * 16 + bias) +
			(x * 17 + bias) +
			(x * 18 + bias) +
			(x * 19 + bias) +
			(x * 20 + bias)
		);
	}
	globalThis.escapedProjection = project;
	project.marker = seed;
	let total = 0;
	for (let i = 0; i < 20; i++) {
		bias = seed + i;
		total += project(i);
	}
	check("private calls see current bindings", total, 210 * 190 + 20 * (20 * seed + 190));
	check("unchanged function identity", globalThis.escapedProjection, project);
	check("unchanged source arity", project.length, 1);
	check("unchanged name", project.name, "project");
	check("unchanged function properties", project.marker, seed);
	check("extra arguments stay generic", project(2, 123), 420 + 20 * bias);
	check("missing arguments stay generic", Number.isNaN(project()), true);
	bias += 10;
	check(
		"capture is taken after argument evaluation",
		project((bias++, 3)),
		630 + 20 * bias,
	);
	return { project, bias };
}
const declared = makeDeclared(17);
check("declared generic bridge", declared.project(3), 630 + 20 * declared.bias);
const left = make(7);
const right = make(43);
for (let i = 0; i < 20; i++) {
	const state = i & 1 ? left : right;
	check(
		"generic calls after creator returns",
		state.project(i),
		210 * i + 20 * state.bias,
	);
	check(
		"apply bridge",
		Reflect.apply(state.project, null, [i]),
		210 * i + 20 * state.bias,
	);
}
check(
	"different activations keep different identity",
	left.project === right.project,
	false,
);

function beforeInitialization() {
	const read = (x) => x + value;
	globalThis.escapedTdz = read;
	let caught = false;
	try {
		read(1);
	} catch (error) {
		caught = error instanceof ReferenceError;
	}
	check("private bridge preserves TDZ", caught, true);
	const value = 6;
	check("initialized local call", read(2), 8);
	return read;
}
check("initialized generic call", beforeInitialization()(3), 9);

function constructible(seed) {
	const bias = seed;
	function Reader(x) {
		this.value = x + bias;
	}
	const receiver = { value: 0 };
	Reader.call(receiver, 5);
	const instance = new Reader(9);
	check("original constructor identity", instance instanceof Reader, true);
	check(
		"original constructor prototype",
		Object.getPrototypeOf(instance),
		Reader.prototype,
	);
	check("original constructor state", instance.value, 9 + seed);
	check("call receiver", receiver.value, 5 + seed);
}
constructible(11);

function heapCapture(seed) {
	const state = { value: seed };
	const read = (x) => x + state.value;
	globalThis.escapedHeapRead = read;
	const input = {
		valueOf() {
			state.value += 1;
			return 4;
		},
	};
	check("reentry preserves operand evaluation order", read(input), 4 + seed);
	state.value += 10;
	check("subsequent call reads current heap contents", read(2), 13 + seed);
	return read;
}
const retained = heapCapture(31);
for (let i = 0; i < 100; i++) heapCapture(i);
check("heap capture survives later allocation", retained(3), 45);

function reentrantMutation(seed) {
	let bias = seed;
	const read = (x) => +x + bias;
	globalThis.escapedMutableRead = read;
	const input = {
		valueOf() {
			bias += 10;
			return 4;
		},
	};
	check("sibling writes stay live", read(input), seed + 14);
	return read;
}
check("mutable generic state", reentrantMutation(5)(3), 18);
function reassignedDeclaration(seed) {
	const bias = seed;
	function read(x) {
		return x + bias;
	}
	globalThis.readCurrentDeclaration = () => read;
	read = (x) => x * 2;
	check("reassigned declaration keeps current callee", read(5), 10);
	check(
		"reassigned captured declaration identity",
		globalThis.readCurrentDeclaration(),
		read,
	);
}
reassignedDeclaration(99);
// Capture conversion must not hoist a TDZ check before user code in the helper.
function coercionBeforeTdz() {
	let coerced = 0;
	const read = (x) => +x + value;
	globalThis.escapedCoercionRead = read;
	let caught = false;
	try {
		read({
			valueOf() {
				coerced++;
				return 4;
			},
		});
	} catch (error) {
		caught = error instanceof ReferenceError;
	}
	check("coercion precedes capture TDZ", coerced, 1);
	check("capture TDZ still throws", caught, true);
	const value = 6;
	check("initialized private coercion call", read(2), 8);
	return read;
}
check("initialized generic coercion call", coercionBeforeTdz()(3), 9);

function controlFlowCaptures(seed) {
	let bias = seed;
	const project = (x) => {
		if (x < 0) throw bias;
		let sum = 0;
		for (let i = 0; i < x; i++) {
			if (i & 1) continue;
			sum += i + bias;
		}
		switch (x & 3) {
			case 0:
				return sum + bias;
			case 1:
				return sum - bias;
			default:
				return sum + x * bias;
		}
	};
	globalThis.controlFlowProjection = project;
	for (let x = 0; x < 20; x++) {
		bias = seed + x;
		let expected = 0;
		for (let i = 0; i < x; i += 2) expected += i + bias;
		expected += (x & 3) === 0 ? bias : (x & 3) === 1 ? -bias : x * bias;
		check("private CFG capture and loop phi", project(x), expected);
	}
	let caught;
	try {
		project(-1);
	} catch (error) {
		caught = error;
	}
	check("private CFG throwing exit", caught, bias);
	check("private CFG function identity", globalThis.controlFlowProjection, project);
	return project;
}
const controlFlowLeft = controlFlowCaptures(7);
const controlFlowRight = controlFlowCaptures(31);
check("generic CFG left activation", controlFlowLeft(4), 80);
check("generic CFG right activation", Reflect.apply(controlFlowRight, null, [4]), 152);
console.log("closure-private-bridge PASS");
