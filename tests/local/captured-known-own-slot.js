const ok = function (name, condition) {
	if (!condition) throw new Error("captured-known-own-slot failure: " + name);
};

const exercise = function (secondOrigin) {
	let state;
	if (secondOrigin) state = { tag: "second", x: 2 };
	else state = { x: 1 };

	const sum = function (count) {
		let total = 0;
		for (let index = 0; index < count; index++) total += state.x;
		return total;
	};

	ok("initial slot", sum(4) === (secondOrigin ? 8 : 4));
	state.x = 3;
	ok("same-shape overwrite", sum(4) === 12);

	let getterCalls = 0;
	delete state.x;
	Object.defineProperty(state, "x", {
		configurable: true,
		get() {
			getterCalls++;
			return 4;
		},
	});
	ok("accessor fallback", sum(4) === 16 && getterCalls === 4);

	let proxyCalls = 0;
	state = new Proxy(
		{ x: 5 },
		{
			get(target, key) {
				proxyCalls++;
				return target[key];
			},
		},
	);
	ok("proxy fallback", sum(4) === 20 && proxyCalls === 4);

	state = { y: 0, x: 6 };
	ok("different-shape fallback", sum(4) === 24);
};

exercise(false);
exercise(true);

const aggregateExercise = function (name, mutate, expected) {
	const holder = { value: { x: 1 } };
	mutate(holder);
	let total = 0;
	for (let index = 0; index < 4; index++) total += holder.value.x;
	ok(name, total === expected);
};

aggregateExercise("aggregate initial slot", () => {}, 4);
aggregateExercise(
	"aggregate same-shape replacement",
	(holder) => {
		holder.value = { x: 2 };
	},
	8,
);
aggregateExercise(
	"aggregate different-shape fallback",
	(holder) => {
		holder.value = { tag: "different", x: 3 };
	},
	12,
);

let aggregateGetterCalls = 0;
aggregateExercise(
	"aggregate accessor fallback",
	(holder) => {
		const value = { y: 0, x: 4 };
		Object.defineProperty(holder, "value", {
			get() {
				aggregateGetterCalls++;
				return value;
			},
		});
	},
	16,
);
ok("aggregate accessor count", aggregateGetterCalls === 4);

let aggregateProxyCalls = 0;
aggregateExercise(
	"aggregate Proxy fallback",
	(holder) => {
		holder.value = new Proxy(
			{ x: 5 },
			{
				get(target, key) {
					aggregateProxyCalls++;
					return target[key];
				},
			},
		);
	},
	20,
);
ok("aggregate Proxy count", aggregateProxyCalls === 4);

const storeExercise = function (state) {
	for (let index = 0; index < 4; index++) state.x = index + 1;
	return state.x;
};

const stored = { x: 0 };
ok("guarded store hit", storeExercise(stored) === 4 && stored.x === 4);

let setterCalls = 0;
let setterValue = 0;
const accessorStore = { x: 0 };
Object.defineProperty(accessorStore, "x", {
	configurable: true,
	get() {
		return setterValue;
	},
	set(value) {
		setterCalls++;
		setterValue = value;
	},
});
ok("guarded store accessor fallback", storeExercise(accessorStore) === 4);
ok("guarded store accessor count", setterCalls === 4);

let proxyStoreCalls = 0;
const proxyStore = new Proxy(
	{ x: 0 },
	{
		set(target, key, value) {
			proxyStoreCalls++;
			target[key] = value;
			return true;
		},
	},
);
ok("guarded store Proxy fallback", storeExercise(proxyStore) === 4);
ok("guarded store Proxy count", proxyStoreCalls === 4);

console.log("captured-known-own-slot PASS");
