let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function caught(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

const checks = [];

function fulfilled(name, promise, check) {
	checks.push(
		promise.then((value) => {
			ok(name, check(value));
		}),
	);
}

function rejected(name, promise, check) {
	checks.push(
		promise.then(
			() => {
				throw new Error("FAIL " + name + " fulfilled");
			},
			(error) => {
				ok(name, check(error));
			},
		),
	);
}

const exact = Promise.resolve(20).then((value) => value + 22);
ok(
	"exact intrinsic then result",
	exact instanceof Promise &&
		exact.constructor === Promise &&
		Object.getPrototypeOf(exact) === Promise.prototype,
);
fulfilled("exact intrinsic settlement", exact, (value) => value === 42);

let releasePending;
const pendingSource = new Promise((resolve) => {
	releasePending = resolve;
});
const pendingResult = pendingSource.then((value) => value + 1);
if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
releasePending(50);
fulfilled(
	"pending reaction retains direct target",
	pendingResult,
	(value) => value === 51,
);

const lookupLog = [];
const lookupSource = Promise.resolve(3);
const lookupConstructor = {};
Object.defineProperty(lookupSource, "constructor", {
	get() {
		lookupLog.push("constructor");
		return lookupConstructor;
	},
});
Object.defineProperty(lookupConstructor, Symbol.species, {
	get() {
		lookupLog.push("species");
		return Promise;
	},
});
const lookupResult = lookupSource.then((value) => value * 2);
ok("constructor and species lookup order", lookupLog.join(",") === "constructor,species");
fulfilled("custom lookup selecting intrinsic", lookupResult, (value) => value === 6);

class IntrinsicSpeciesPromise extends Promise {
	static get [Symbol.species]() {
		return Promise;
	}
}
const intrinsicSpeciesResult = new IntrinsicSpeciesPromise((resolve) => resolve(8)).then(
	(value) => value + 1,
);
ok(
	"subclass selecting exact intrinsic",
	intrinsicSpeciesResult instanceof Promise &&
		!(intrinsicSpeciesResult instanceof IntrinsicSpeciesPromise) &&
		Object.getPrototypeOf(intrinsicSpeciesResult) === Promise.prototype,
);
fulfilled(
	"subclass intrinsic species settlement",
	intrinsicSpeciesResult,
	(value) => value === 9,
);

const subclassExecutors = [];
class SubPromise extends Promise {
	constructor(executor) {
		subclassExecutors.push(typeof executor);
		super(executor);
	}
}
const subclassSource = new SubPromise((resolve) => resolve(10));
const subclassExecutorCount = subclassExecutors.length;
const subclassResult = subclassSource.then((value) => value + 2);
ok(
	"subclass uses NewPromiseCapability",
	subclassResult instanceof SubPromise &&
		subclassExecutors.length === subclassExecutorCount + 1 &&
		subclassExecutors[subclassExecutors.length - 1] === "function",
);
fulfilled("subclass capability settles", subclassResult, (value) => value === 12);

let customResolve;
let customReject;
function CustomCapability(executor) {
	ok("custom constructor receives callable executor", typeof executor === "function");
	executor(
		(value) => {
			customResolve = value;
		},
		(reason) => {
			customReject = reason;
		},
	);
	this.custom = true;
}
const customSource = Promise.resolve(5);
customSource.constructor = { [Symbol.species]: CustomCapability };
const customResult = customSource.then((value) => value + 7);
ok("custom species result object", customResult.custom === true);
checks.push(
	Promise.resolve().then(() => {
		ok(
			"custom species callable resolve",
			customResolve === 12 && customReject === undefined,
		);
	}),
);

const constructorError = { kind: "constructor" };
const throwingConstructorSource = Promise.resolve();
Object.defineProperty(throwingConstructorSource, "constructor", {
	get() {
		throw constructorError;
	},
});
ok(
	"throwing constructor getter",
	caught(() => throwingConstructorSource.then(() => {})) === constructorError,
);

const speciesError = { kind: "species" };
const throwingSpeciesSource = Promise.resolve();
throwingSpeciesSource.constructor = {};
Object.defineProperty(throwingSpeciesSource.constructor, Symbol.species, {
	get() {
		throw speciesError;
	},
});
ok(
	"throwing species getter",
	caught(() => throwingSpeciesSource.then(() => {})) === speciesError,
);

const constructionError = { kind: "construction" };
function ThrowingCapability() {
	throw constructionError;
}
const throwingCapabilitySource = Promise.resolve();
throwingCapabilitySource.constructor = { [Symbol.species]: ThrowingCapability };
ok(
	"throwing species constructor",
	caught(() => throwingCapabilitySource.then(() => {})) === constructionError,
);

const badConstructorSource = Promise.resolve();
badConstructorSource.constructor = 1;
ok(
	"non-object constructor",
	caught(() => badConstructorSource.then(() => {})) instanceof TypeError,
);
const badSpeciesSource = Promise.resolve();
badSpeciesSource.constructor = { [Symbol.species]: {} };
ok(
	"non-callable species",
	caught(() => badSpeciesSource.then(() => {})) instanceof TypeError,
);

let cycle;
cycle = Promise.resolve().then(() => cycle);
rejected(
	"direct self-resolution cycle",
	cycle,
	(error) => error instanceof TypeError && /Chaining cycle/.test(error.message),
);

let repeatedCalls = 0;
const repeatedThenable = {
	then(resolve, reject) {
		repeatedCalls++;
		ok("thenable receives resolve callable", typeof resolve === "function");
		ok("thenable receives reject callable", typeof reject === "function");
		resolve(31);
		reject(32);
		resolve(33);
		throw new Error("ignored after resolve");
	},
};
const repeatedResult = Promise.resolve().then(() => repeatedThenable);
fulfilled(
	"returned thenable settles once",
	repeatedResult,
	(value) => value === 31 && repeatedCalls === 1,
);

const getterError = { kind: "then getter" };
let getterCount = 0;
const throwingThenGetter = {};
Object.defineProperty(throwingThenGetter, "then", {
	get() {
		getterCount++;
		throw getterError;
	},
});
const getterResult = Promise.resolve().then(() => throwingThenGetter);
rejected(
	"throwing then getter read exactly once",
	getterResult,
	(error) => error === getterError && getterCount === 1,
);

const nonCallableThen = { then: 1 };
fulfilled(
	"non-callable then fulfills with object",
	Promise.resolve().then(() => nonCallableThen),
	(value) => value === nonCallableThen,
);

const order = [];
const ordered = Promise.resolve().then(() => {
	order.push("handler");
	return {
		get then() {
			order.push("get then");
			return (resolve) => {
				order.push("call then");
				resolve("ordered");
			};
		},
	};
});
Promise.resolve().then(() => order.push("peer"));
checks.push(
	ordered.then((value) => {
		order.push("dependent");
		ok(
			"thenable microtask order",
			value === "ordered" &&
				order.join(",") === "handler,get then,peer,call then,dependent",
		);
	}),
);

// The dependent is intentionally ignored. Its direct rejection must still be
// retained and reported by the checkpoint's unhandled-rejection pass.
Promise.resolve().then(() => {
	throw new Error("direct-unhandled-marker");
});

if (typeof ShadowRealm === "function") {
	const realm = new ShadowRealm();
	const runInner = realm.evaluate(`(report) => {
		let cycle;
		cycle = Promise.resolve(1).then(() => cycle);
		cycle.then(undefined, (error) => report(
			error instanceof TypeError &&
			Object.getPrototypeOf(cycle) === Promise.prototype
		));
	}`);
	const crossRealm = new Promise((resolve) => runInner(resolve));
	fulfilled("cross-realm direct capability realm", crossRealm, (value) => value === true);
}

Promise.all(checks).then(() => {
	ok("focused checks ran", passed >= 25);
	console.log("promise-direct-capability PASS");
});
