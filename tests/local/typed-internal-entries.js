function check(value, message) {
	if (!value) throw new Error(message);
}

function addRepeated(left, right) {
	let result = left;
	for (let index = 0; index < 16; index++) result = result + right;
	return result;
}
const external = [addRepeated];
check(addRepeated(3, 7) === 115, "numeric entry");
check(addRepeated(-0, -0) === 0 && Object.is(addRepeated(-0, -0), -0), "signed zero");
check(Number.isNaN(addRepeated(NaN, 1)), "NaN");
check(addRepeated(Infinity, 1) === Infinity, "infinity");
check(external[0]("a", "b") === "a" + "b".repeat(16), "mixed canonical entry");
external[0] = (left, right) => left - right;
check(external[0](3, 7) === -4, "replaced target");

function argumentEdges(value = 11) {
	const first = arguments.length > 0 ? arguments[0] : value;
	const second = arguments.length > 1 ? arguments[1] : 13;
	const fourth = arguments.length > 3 ? arguments[3] : 19;
	return first * 3 + second * 5 + fourth * 7 + arguments.length;
}
let effects = 0;
check(argumentEdges(1, 2, effects++, 4) === 45, "four supplied arguments");
check(effects === 1, "unused argument evaluation");
check(argumentEdges() === 231, "absent default");
check(Number.isNaN(argumentEdges(undefined)), "present undefined");
check(argumentEdges(2, 3, 5, 7, effects++) === 75, "different arity");
check(effects === 2, "extra argument evaluation");

function inheritedPosition(value) {
	return arguments.length + arguments[2];
}
check(inheritedPosition(1, 2, 3) === 6, "present static position");
let getterReads = 0;
Object.defineProperty(Object.prototype, "2", {
	configurable: true,
	get() {
		getterReads++;
		throw new Error("inherited absent argument");
	},
});
let caught = false;
let finalized = false;
try {
	inheritedPosition(1);
} catch (error) {
	caught = error.message === "inherited absent argument";
} finally {
	finalized = true;
	delete Object.prototype["2"];
}
check(caught && finalized && getterReads === 1, "missing argument fallback timing");

function textAndFlag(text, flag) {
	let output = text;
	for (let index = 0; index < 3; index++) {
		const garbage = { index, output };
		output = flag ? garbage.output + "!" : garbage.output;
	}
	return output;
}
check(textAndFlag("x", true) === "x!!!", "string and boolean entry");
check(textAndFlag("", false) === "", "empty string entry");
console.log("typed-internal-entries PASS");
