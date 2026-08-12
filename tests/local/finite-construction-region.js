const checks = [];

function build(seed) {
	const result = {};
	for (let i = 0; i < 8; i++) {
		result["p" + i] = (seed * (i + 1)) % 251;
	}
	return result;
}

const warm = build(7);
checks.push(
	Object.keys(warm).join(",") === "p0,p1,p2,p3,p4,p5,p6,p7" &&
		warm.p0 === 7 &&
		warm.p7 === 56 &&
		Object.getOwnPropertyDescriptor(warm, "p3").writable === true &&
		Object.getOwnPropertyDescriptor(warm, "p3").enumerable === true &&
		Object.getOwnPropertyDescriptor(warm, "p3").configurable === true,
);

let coercions = 0;
const boxedSeed = {
	valueOf() {
		coercions++;
		return 3;
	},
};
const generic = build(boxedSeed);
checks.push(generic.p0 === 3 && generic.p7 === 24 && coercions === 8);

let setterCalls = 0;
let setterReceiver;
Object.defineProperty(Object.prototype, "p0", {
	set(value) {
		setterCalls += value;
		setterReceiver = this;
	},
	configurable: true,
});
const intercepted = build(2);
checks.push(
	setterCalls === 2 &&
		setterReceiver === intercepted &&
		!Object.prototype.hasOwnProperty.call(intercepted, "p0") &&
		intercepted.p1 === 4,
);
delete Object.prototype.p0;

const refilled = build(5);
checks.push(
	Object.prototype.hasOwnProperty.call(refilled, "p0") &&
		refilled.p0 === 5 &&
		Object.keys(refilled).join(",") === "p0,p1,p2,p3,p4,p5,p6,p7",
);

let mutationSetterCalls = 0;
const mutatingSeed = {
	valueOf() {
		if (!Object.prototype.hasOwnProperty.call(Object.prototype, "p0")) {
			Object.defineProperty(Object.prototype, "p0", {
				set(value) {
					mutationSetterCalls += value;
				},
				configurable: true,
			});
		}
		return 4;
	},
};
const mutatedDuringValue = build(mutatingSeed);
checks.push(
	mutationSetterCalls === 4 &&
		!Object.prototype.hasOwnProperty.call(mutatedDuringValue, "p0") &&
		mutatedDuringValue.p7 === 32,
);
delete Object.prototype.p0;

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
