// Install the baked compiler outside realmA before any of its dynamic code runs.
eval("0");

const realmA = $262.createRealm().global;
const realmB = $262.createRealm().global;
const realmC = $262.createRealm().global;

realmA.calls = 0;
const constructors = realmA.eval(`([
	Function,
	Object.getPrototypeOf(function* () {}).constructor,
	Object.getPrototypeOf(async function () {}).constructor,
	Object.getPrototypeOf(async function* () {}).constructor,
])`);
const fallbackPrototypes = realmB.eval(`([
	Function.prototype,
	Object.getPrototypeOf(function* () {}),
	Object.getPrototypeOf(async function () {}),
	Object.getPrototypeOf(async function* () {}),
])`);

function makeNewTarget(prototype) {
	const target = new realmB.Function();
	let gets = 0;
	Object.defineProperty(target, "prototype", {
		configurable: true,
		get() {
			gets++;
			$262.gc();
			return prototype;
		},
	});
	return {
		target,
		get gets() {
			return gets;
		},
	};
}

const customPrototype = realmC.eval("({})");
for (let index = 0; index < constructors.length; index++) {
	const observed = makeNewTarget(customPrototype);
	const fn = Reflect.construct(
		constructors[index],
		["return globalThis;"],
		observed.target,
	);
	if (Object.getPrototypeOf(fn) !== customPrototype || observed.gets !== 1) {
		throw new Error(
			`dynamic constructor ${index} did not select newTarget.prototype once`,
		);
	}
}

const proxyTarget = new realmB.Function();
proxyTarget.prototype = null;
const proxyNewTarget = new Proxy(proxyTarget, {});
const proxyFunction = Reflect.construct(constructors[3], [], proxyNewTarget);
if (Object.getPrototypeOf(proxyFunction) !== fallbackPrototypes[3]) {
	throw new Error("proxy newTarget fallback did not use its target realm");
}

const revoked = Proxy.revocable(new realmB.Function(), {});
revoked.revoke();
try {
	Reflect.construct(constructors[0], [], revoked.proxy);
	throw new Error("revoked newTarget did not throw");
} catch (error) {
	if (!(error instanceof TypeError)) {
		throw new Error("revoked newTarget did not throw a Reflect-realm TypeError");
	}
}

try {
	Reflect.construct(constructors[0], ["}"], new realmB.Function());
	throw new Error("invalid dynamic source did not throw");
} catch (error) {
	if (!(error instanceof realmA.SyntaxError)) {
		throw new Error("dynamic parse error did not use the constructor realm");
	}
}

const normalTarget = new realmB.Function();
normalTarget.prototype = null;
const normal = Reflect.construct(
	constructors[0],
	["'use strict'; calls += 1; return globalThis;"],
	normalTarget,
);
if (Object.getPrototypeOf(normal) !== fallbackPrototypes[0]) {
	throw new Error("Function fallback prototype did not use the newTarget realm");
}
if (Object.getPrototypeOf(normal.prototype) !== realmA.Object.prototype) {
	throw new Error("Function instance prototype did not use the constructor realm");
}
if (normal() !== realmA || realmA.calls !== 1) {
	throw new Error("Function body did not use the constructor global environment");
}
const generatorTarget = new realmB.Function();
generatorTarget.prototype = null;
const GeneratorFunction = constructors[1];
const generator = Reflect.construct(
	GeneratorFunction,
	["calls += 1; yield globalThis;"],
	generatorTarget,
);
const iterator = generator();
const step = iterator.next();
if (
	Object.getPrototypeOf(generator) !== fallbackPrototypes[1] ||
	step.value !== realmA ||
	realmA.calls !== 2
) {
	throw new Error("GeneratorFunction lost constructor realm semantics");
}

const asyncTarget = new realmB.Function();
asyncTarget.prototype = null;
const AsyncFunction = constructors[2];
const asyncFunction = Reflect.construct(
	AsyncFunction,
	["'use strict'; calls += 1; return globalThis;"],
	asyncTarget,
);
const asyncResult = asyncFunction();

const asyncGeneratorTarget = new realmB.Function();
asyncGeneratorTarget.prototype = null;
const AsyncGeneratorFunction = constructors[3];
const asyncGenerator = Reflect.construct(
	AsyncGeneratorFunction,
	["calls += 1; yield globalThis;"],
	asyncGeneratorTarget,
);
asyncResult
	.then((asyncValue) => {
		if (
			Object.getPrototypeOf(asyncFunction) !== fallbackPrototypes[2] ||
			asyncValue !== realmA ||
			realmA.calls !== 3
		) {
			throw new Error("AsyncFunction lost constructor realm semantics");
		}
		return asyncGenerator().next();
	})
	.then((asyncStep) => {
		if (
			Object.getPrototypeOf(asyncGenerator) !== fallbackPrototypes[3] ||
			asyncStep.value !== realmA ||
			realmA.calls !== 4
		) {
			throw new Error("AsyncGeneratorFunction lost constructor realm semantics");
		}
		console.log("dynamic-function-cross-realm PASS 1/1");
	});
