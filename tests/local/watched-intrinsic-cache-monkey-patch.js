function callFloor(value) {
	return Math.floor(value);
}

const originalFloor = Math.floor;
for (let i = 0; i < 100; i++) {
	if (callFloor(7.9) !== 7) throw new Error("warm failure");
}
Math.floor = function () {
	return 71;
};
if (callFloor(7.9) !== 71) throw new Error("monkey patch was not observed");
Math.floor = originalFloor;

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

const coercions = [];
const coercedMax = Math.max(
	{
		valueOf() {
			coercions.push("left");
			return NaN;
		},
	},
	{
		valueOf() {
			coercions.push("right");
			return 9;
		},
	},
);
if (!Number.isNaN(coercedMax) || coercions.join(",") !== "left,right")
	throw new Error("Math.max coercion fallback order");

let proxyCalls = 0;
Math.floor = new Proxy(originalFloor, {
	apply(target, thisValue, args) {
		proxyCalls++;
		return Reflect.apply(target, thisValue, args);
	},
});
if (callFloor(7.9) !== 7 || proxyCalls !== 1) throw new Error("Math proxy fallback");
Math.floor = originalFloor;

let bigintThrew = false;
try {
	Math.round(1n);
} catch (error) {
	bigintThrew = error instanceof TypeError;
}
if (!bigintThrew) throw new Error("Math BigInt fallback");
console.log("watched-intrinsic-cache-monkey-patch PASS");
