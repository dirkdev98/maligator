function callFloor(value) {
	return Math.floor(value);
}

for (let i = 0; i < 100; i++) {
	if (callFloor(7.9) !== 7) throw new Error("warm failure");
}
Math.floor = function () {
	return 71;
};
if (callFloor(7.9) !== 71) throw new Error("monkey patch was not observed");

const originalAbs = Math.abs;
function replaceAbsDuringArgumentEvaluation() {
	Math.abs = function () {
		return 72;
	};
	return -4;
}
function callAbsWithMutation() {
	return Math.abs(replaceAbsDuringArgumentEvaluation());
}
if (callAbsWithMutation() !== 4) throw new Error("loaded Math callee was not retained");
if (callAbsWithMutation() !== 72)
	throw new Error("replacement Math callee was not observed");
Math.abs = originalAbs;

const originalMax = Math.max;
function replaceMaxDuringArgumentEvaluation() {
	Math.max = function () {
		return 73;
	};
	return 8;
}
function callMaxWithMutation() {
	return Math.max(7, replaceMaxDuringArgumentEvaluation());
}
if (callMaxWithMutation() !== 8)
	throw new Error("loaded binary Math callee was not retained");
if (callMaxWithMutation() !== 73)
	throw new Error("replacement binary Math callee was not observed");
Math.max = originalMax;

if (!Object.is(Math.round(-0.4), -0) || Math.round(1.5) !== 2)
	throw new Error("round fast path semantics");
if (!Object.is(Math.min(0, -0), -0) || !Object.is(Math.max(-0, 0), 0))
	throw new Error("min/max signed zero fast path semantics");
console.log("watched-intrinsic-cache-monkey-patch PASS");
