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

const functionCallRelay = function (overrideCall) {
	const identity = function (value) {
		return value;
	};
	let proxyGetCalls = 0;
	if (overrideCall) {
		identity.call = function (_thisValue, value) {
			return new Proxy(
				{ x: value.x + 1 },
				{
					get(target, key) {
						proxyGetCalls++;
						return target[key];
					},
				},
			);
		};
	}
	const relayed = identity.call(null, { x: 6 });
	let total = 0;
	for (let index = 0; index < 4; index++) total += relayed.x;
	return { total, proxyGetCalls };
};

const intrinsicCallRelay = functionCallRelay(false);
ok(
	"Function.call shape relay hit",
	intrinsicCallRelay.total === 24 && intrinsicCallRelay.proxyGetCalls === 0,
);
const overriddenCallRelay = functionCallRelay(true);
ok(
	"Function.call shape relay fallback",
	overriddenCallRelay.total === 28 && overriddenCallRelay.proxyGetCalls === 4,
);

const constructorReturnRelay = function (proxyConstructor) {
	const Forward = function (value) {
		return { x: value.x };
	};
	let Constructor = Forward;
	let proxyGetCalls = 0;
	if (proxyConstructor) {
		Constructor = new Proxy(Forward, {
			construct(_target, argumentsList) {
				return new Proxy(
					{ x: argumentsList[0].x + 1 },
					{
						get(target, key) {
							proxyGetCalls++;
							return target[key];
						},
					},
				);
			},
		});
	}
	const constructed = new Constructor({ x: 6 });
	let total = 0;
	for (let index = 0; index < 4; index++) total += constructed.x;
	return { total, proxyGetCalls };
};

const directConstructorReturn = constructorReturnRelay(false);
ok(
	"constructor object return shape relay hit",
	directConstructorReturn.total === 24 && directConstructorReturn.proxyGetCalls === 0,
);
const proxyConstructorReturn = constructorReturnRelay(true);
ok(
	"constructor object return shape relay fallback",
	proxyConstructorReturn.total === 28 && proxyConstructorReturn.proxyGetCalls === 4,
);

const spreadCallReturnRelay = function (proxyCallee) {
	const Factory = function (value) {
		return { x: value };
	};
	let callee = Factory;
	let proxyGetCalls = 0;
	if (proxyCallee) {
		callee = new Proxy(Factory, {
			apply(_target, _receiver, argumentsList) {
				return new Proxy(
					{ x: argumentsList[0] + 1 },
					{
						get(target, key) {
							proxyGetCalls++;
							return target[key];
						},
					},
				);
			},
		});
	}
	const argumentsList = [6];
	const produced = callee(...argumentsList);
	let total = 0;
	for (let index = 0; index < 4; index++) total += produced.x;
	return { total, proxyGetCalls };
};

const directSpreadCallReturn = spreadCallReturnRelay(false);
ok(
	"spread-call object return shape relay hit",
	directSpreadCallReturn.total === 24 && directSpreadCallReturn.proxyGetCalls === 0,
);
const proxySpreadCallReturn = spreadCallReturnRelay(true);
ok(
	"spread-call object return shape relay fallback",
	proxySpreadCallReturn.total === 28 && proxySpreadCallReturn.proxyGetCalls === 4,
);

const objectMethodRelay = function (proxyReceiver) {
	const object = {
		x: 6,
		read(count) {
			let total = 0;
			for (let index = 0; index < count; index++) total += this.x;
			return total;
		},
	};
	let receiver = object;
	let proxyGetCalls = 0;
	if (proxyReceiver) {
		receiver = new Proxy(object, {
			get(target, key, currentReceiver) {
				proxyGetCalls++;
				return Reflect.get(target, key, currentReceiver);
			},
		});
	}
	const total = receiver.read(4);
	return { total, proxyGetCalls };
};

const directObjectMethod = objectMethodRelay(false);
ok(
	"object method literal shape hit",
	directObjectMethod.total === 24 && directObjectMethod.proxyGetCalls === 0,
);
const proxyObjectMethod = objectMethodRelay(true);
ok(
	"object method literal receiver fallback",
	proxyObjectMethod.total === 24 && proxyObjectMethod.proxyGetCalls === 5,
);

console.log("captured-known-own-slot PASS");
