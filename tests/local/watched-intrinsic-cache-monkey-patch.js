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
console.log("watched-intrinsic-cache-monkey-patch PASS");
