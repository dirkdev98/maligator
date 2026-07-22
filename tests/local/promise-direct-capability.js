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

const exactResolved = Promise.resolve(19);
ok(
	"exact Promise.resolve shape",
	exactResolved instanceof Promise &&
		exactResolved.constructor === Promise &&
		Object.getPrototypeOf(exactResolved) === Promise.prototype,
);
fulfilled("exact Promise.resolve settlement", exactResolved, (value) => value === 19);

let sameConstructorGets = 0;
const samePromise = Promise.resolve(23);
Object.defineProperty(samePromise, "constructor", {
	get() {
		sameConstructorGets++;
		return Promise;
	},
});
ok(
	"Promise.resolve same-constructor short circuit",
	Promise.resolve(samePromise) === samePromise && sameConstructorGets === 1,
);

let changedConstructorGets = 0;
const changedConstructorPromise = Promise.resolve(29);
Object.defineProperty(changedConstructorPromise, "constructor", {
	get() {
		changedConstructorGets++;
		return {};
	},
});
const changedConstructorWrapped = Promise.resolve(changedConstructorPromise);
ok(
	"Promise.resolve changed constructor wraps after one optimization lookup",
	changedConstructorWrapped !== changedConstructorPromise && changedConstructorGets === 1,
);
fulfilled(
	"Promise.resolve changed constructor settlement",
	changedConstructorWrapped,
	(value) => value === 29,
);

const exactRejectReason = { kind: "exact reject" };
const exactRejected = Promise.reject(exactRejectReason);
ok(
	"exact Promise.reject shape",
	exactRejected instanceof Promise &&
		Object.getPrototypeOf(exactRejected) === Promise.prototype,
);
rejected(
	"exact Promise.reject settlement",
	exactRejected,
	(reason) => reason === exactRejectReason,
);

let staticThenGets = 0;
let staticThenCalls = 0;
const staticThenable = {
	get then() {
		staticThenGets++;
		return (resolve, reject) => {
			staticThenCalls++;
			ok("Promise.resolve thenable resolve callable", typeof resolve === "function");
			ok("Promise.resolve thenable reject callable", typeof reject === "function");
			resolve(31);
			reject(32);
			resolve(33);
		};
	},
};
const staticThenablePromise = Promise.resolve(staticThenable);
ok(
	"Promise.resolve gets then once before job",
	staticThenGets === 1 && staticThenCalls === 0,
);
fulfilled(
	"Promise.resolve assimilates thenable once",
	staticThenablePromise,
	(value) => value === 31 && staticThenGets === 1 && staticThenCalls === 1,
);

let customResolveValue;
let customResolveExecutorCallable = false;
function CustomResolveCapability(executor) {
	customResolveExecutorCallable = typeof executor === "function";
	executor(
		(value) => {
			customResolveValue = value;
		},
		() => {
			throw new Error("custom resolve rejected");
		},
	);
	this.kind = "custom resolve";
}
const customStaticResolved = Promise.resolve.call(CustomResolveCapability, 37);
ok(
	"custom Promise.resolve retains capability callbacks",
	customStaticResolved.kind === "custom resolve" &&
		customResolveExecutorCallable &&
		customResolveValue === 37,
);

let customRejectReason;
let customRejectExecutorCallable = false;
function CustomRejectCapability(executor) {
	customRejectExecutorCallable = typeof executor === "function";
	executor(
		() => {
			throw new Error("custom reject resolved");
		},
		(reason) => {
			customRejectReason = reason;
		},
	);
	this.kind = "custom reject";
}
const customStaticRejectReason = { kind: "custom reject reason" };
const customStaticRejected = Promise.reject.call(
	CustomRejectCapability,
	customStaticRejectReason,
);
ok(
	"custom Promise.reject retains capability callbacks",
	customStaticRejected.kind === "custom reject" &&
		customRejectExecutorCallable &&
		customRejectReason === customStaticRejectReason,
);
ok(
	"generic Promise.resolve validates constructor",
	caught(() => Promise.resolve.call({}, 1)) instanceof TypeError,
);
ok(
	"generic Promise.reject validates constructor",
	caught(() => Promise.reject.call({}, 1)) instanceof TypeError,
);

let constructorResolve;
let constructorReject;
const exposedConstructorPromise = new Promise((resolve, reject) => {
	constructorResolve = resolve;
	constructorReject = reject;
});
ok(
	"Promise constructor exposes callable pair",
	typeof constructorResolve === "function" && typeof constructorReject === "function",
);
constructorResolve(41);
constructorReject(42);
fulfilled(
	"Promise constructor pair remains AlreadyResolved",
	exposedConstructorPromise,
	(value) => value === 41,
);

const exposedCapability = Promise.withResolvers();
ok(
	"Promise.withResolvers exposes callable pair",
	typeof exposedCapability.resolve === "function" &&
		typeof exposedCapability.reject === "function",
);
exposedCapability.resolve(43);
exposedCapability.reject(44);
fulfilled(
	"Promise.withResolvers pair remains AlreadyResolved",
	exposedCapability.promise,
	(value) => value === 43,
);

let customAllSawCallablePair = false;
function CustomAllCapability(executor) {
	return new Promise((resolve, reject) => {
		customAllSawCallablePair =
			customAllSawCallablePair ||
			(typeof resolve === "function" && typeof reject === "function");
		executor(resolve, reject);
	});
}
CustomAllCapability.resolve = Promise.resolve;
const customAll = Promise.all.call(CustomAllCapability, [2, 3]);
ok(
	"Promise.all custom result capability is real",
	customAll instanceof Promise && customAllSawCallablePair,
);
fulfilled(
	"Promise.all custom result capability settles",
	customAll,
	(values) => values[0] === 2 && values[1] === 3,
);

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

const asyncThrowReason = { kind: "async throw" };
const asyncAwaitRejectReason = { kind: "async await reject" };
async function asyncFulfill() {
	return 47;
}
async function asyncThrow() {
	throw asyncThrowReason;
}
async function asyncAwaitPrimitive() {
	return (await 48) + 1;
}
async function asyncAwaitRejected() {
	await Promise.reject(asyncAwaitRejectReason);
}
async function asyncReturnThenable() {
	return {
		then(resolve, reject) {
			ok("async return thenable resolve callable", typeof resolve === "function");
			ok("async return thenable reject callable", typeof reject === "function");
			resolve(50);
			reject(51);
		},
	};
}
async function asyncAwaitThenable() {
	const value = await {
		then(resolve, reject) {
			ok("await thenable resolve callable", typeof resolve === "function");
			ok("await thenable reject callable", typeof reject === "function");
			resolve(52);
			reject(53);
		},
	};
	return value + 1;
}

const asyncFulfilled = asyncFulfill();
ok(
	"async result is exact intrinsic Promise",
	asyncFulfilled instanceof Promise &&
		asyncFulfilled.constructor === Promise &&
		Object.getPrototypeOf(asyncFulfilled) === Promise.prototype,
);
fulfilled("async return fulfills direct result", asyncFulfilled, (value) => value === 47);
rejected(
	"async throw rejects direct result",
	asyncThrow(),
	(reason) => reason === asyncThrowReason,
);
fulfilled(
	"await primitive uses direct normalization",
	asyncAwaitPrimitive(),
	(value) => value === 49,
);
rejected(
	"await rejection rejects direct async result",
	asyncAwaitRejected(),
	(reason) => reason === asyncAwaitRejectReason,
);
fulfilled(
	"async return assimilates thenable",
	asyncReturnThenable(),
	(value) => value === 50,
);
fulfilled("await assimilates thenable", asyncAwaitThenable(), (value) => value === 53);

const awaitConstructorError = { kind: "await constructor getter" };
const awaitPoisonedPromise = Promise.resolve(54);
Object.defineProperty(awaitPoisonedPromise, "constructor", {
	get() {
		throw awaitConstructorError;
	},
});
async function awaitPoisoned() {
	return await awaitPoisonedPromise;
}
rejected(
	"await preserves PromiseResolve constructor abrupt completion",
	awaitPoisoned(),
	(reason) => reason === awaitConstructorError,
);

let asyncCycle;
async function asyncSelfResolution() {
	await 0;
	return asyncCycle;
}
asyncCycle = asyncSelfResolution();
rejected(
	"async direct self-resolution cycle",
	asyncCycle,
	(error) => error instanceof TypeError && /Chaining cycle/.test(error.message),
);

let releaseAsyncGate;
const asyncGate = new Promise((resolve) => {
	releaseAsyncGate = resolve;
});
async function asyncAcrossGc() {
	const value = await asyncGate;
	return value + 1;
}
const asyncGcResult = asyncAcrossGc();
if (typeof __mal_collect_garbage === "function") __mal_collect_garbage();
releaseAsyncGate(54);
fulfilled(
	"async direct target survives suspension GC",
	asyncGcResult,
	(value) => value === 55,
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
Promise.reject(new Error("direct-intrinsic-unhandled-marker"));
async function asyncUnhandled() {
	throw new Error("direct-async-unhandled-marker");
}
asyncUnhandled();

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

	const runInnerAsync = realm.evaluate(`(report) => {
		const reason = {};
		async function fulfill() { return (await 60) + 1; }
		async function reject() { throw reason; }
		let cycle;
		async function selfResolve() { await 0; return cycle; }
		cycle = selfResolve();
		const fulfilled = fulfill();
		Promise.all([
			fulfilled.then((value) =>
				value === 61 && Object.getPrototypeOf(fulfilled) === Promise.prototype),
			reject().then(undefined, (error) => error === reason),
			cycle.then(undefined, (error) => error instanceof TypeError),
		]).then((values) => report(values[0] && values[1] && values[2]));
	}`);
	const crossRealmAsync = new Promise((resolve) => runInnerAsync(resolve));
	fulfilled(
		"cross-realm intrinsic and async result realm",
		crossRealmAsync,
		(value) => value === true,
	);
}

Promise.all(checks).then(() => {
	ok("focused checks ran", passed >= 55);
	console.log("promise-direct-capability PASS");
});
