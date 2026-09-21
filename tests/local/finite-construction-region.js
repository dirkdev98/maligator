const checks = [];

function build(seed) {
	const result = {};
	for (let i = 0; i < 8; i++) {
		result["p" + i] = (seed * (i + 1)) % 251;
	}
	return result;
}

function consume(seed) {
	const result = {};
	for (let i = 0; i < 8; i++) {
		result["p" + i] = (seed * (i + 1)) % 251;
	}
	let total = 0;
	for (let i = 0; i < 8; i++) {
		total += result["p" + i];
	}
	return total;
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

checks.push(consume(3) === 108);

let consumedSetterCalls = 0;
Object.defineProperty(Object.prototype, "p0", {
	set(value) {
		consumedSetterCalls += value;
	},
	configurable: true,
});
checks.push(Number.isNaN(consume(2)) && consumedSetterCalls === 2);
delete Object.prototype.p0;
checks.push(consume(4) === 144);

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

class ScalarPair {
	constructor(left, right) {
		this.left = left;
		this.right = right;
	}

	total() {
		return this.left + this.right;
	}
}

function consumePair(left, right) {
	return new ScalarPair(left, right).total();
}

const originalTotal = ScalarPair.prototype.total;
checks.push(consumePair(2, 3) === 5);
ScalarPair.prototype.total = function () {
	return this.left * this.right;
};
checks.push(consumePair(3, 4) === 12);

let methodGets = 0;
Object.defineProperty(ScalarPair.prototype, "total", {
	configurable: true,
	get() {
		methodGets++;
		return originalTotal;
	},
});
checks.push(consumePair(5, 6) === 11 && methodGets === 1);
Object.defineProperty(ScalarPair.prototype, "total", {
	configurable: true,
	writable: true,
	value: originalTotal,
});
checks.push(consumePair(7, 8) === 15);

let pairSetterReceiver;
Object.defineProperty(ScalarPair.prototype, "left", {
	configurable: true,
	set() {
		pairSetterReceiver = this;
	},
});
const interceptedPair = new ScalarPair(9, 10);
checks.push(
	Number.isNaN(interceptedPair.total()) && pairSetterReceiver === interceptedPair,
);
delete ScalarPair.prototype.left;

function consumePairAfterArgumentMutation(left, right) {
	return new ScalarPair(left(), right).total();
}
checks.push(
	consumePairAfterArgumentMutation(() => {
		ScalarPair.prototype.total = function () {
			return 91;
		};
		return 1;
	}, 2) === 91,
);
ScalarPair.prototype.total = originalTotal;

class FrozenPair {
	constructor(value) {
		this.value = value;
	}

	frozenTotal() {
		return this.value + 1;
	}
}
Object.defineProperty(FrozenPair.prototype, "frozenTotal", { writable: false });
checks.push(new FrozenPair(9).frozenTotal() === 10);

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
