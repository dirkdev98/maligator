let passed = 0;
const checks = [];

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

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
			(reason) => {
				ok(name, check(reason));
			},
		),
	);
}

const IntrinsicPromise = Promise;
async function* basic() {
	yield 11;
	return 13;
}
const basicIterator = basic();
const firstPromise = basicIterator.next();
ok(
	"next exact intrinsic Promise",
	firstPromise instanceof IntrinsicPromise &&
		firstPromise.constructor === IntrinsicPromise &&
		Object.getPrototypeOf(firstPromise) === IntrinsicPromise.prototype,
);
fulfilled(
	"next fulfills iterator result",
	firstPromise,
	(result) => result.value === 11 && result.done === false,
);
fulfilled(
	"next fulfills completion",
	basicIterator.next(),
	(result) => result.value === 13 && result.done === true,
);
fulfilled(
	"next after completion",
	basicIterator.next(),
	(result) => result.value === undefined && result.done === true,
);

const returned = basic().return(17);
ok(
	"return exact intrinsic Promise",
	returned instanceof IntrinsicPromise &&
		Object.getPrototypeOf(returned) === IntrinsicPromise.prototype,
);
fulfilled(
	"return fulfills iterator result",
	returned,
	(result) => result.value === 17 && result.done === true,
);

const throwReason = { kind: "throw request" };
const thrown = basic().throw(throwReason);
ok(
	"throw exact intrinsic Promise",
	thrown instanceof IntrinsicPromise &&
		Object.getPrototypeOf(thrown) === IntrinsicPromise.prototype,
);
rejected("throw rejects request Promise", thrown, (reason) => reason === throwReason);

let releaseAwaitedReturn;
const awaitedReturnValue = new IntrinsicPromise((resolve) => {
	releaseAwaitedReturn = resolve;
});
const awaitedReturnIterator = basic();
const awaitedReturnQueue = [
	awaitedReturnIterator.return(awaitedReturnValue),
	awaitedReturnIterator.next(),
	awaitedReturnIterator.return(IntrinsicPromise.resolve(61)),
];

const suspendedStartError = new Error("suspended-start broken return");
const suspendedStartBroken = IntrinsicPromise.resolve(0);
Object.defineProperty(suspendedStartBroken, "constructor", {
	get() {
		throw suspendedStartError;
	},
});
rejected(
	"suspended-start return rejects broken Promise",
	basic().return(suspendedStartBroken),
	(reason) => reason === suspendedStartError,
);

async function* empty() {}
const completedIterator = empty();
const completedError = new Error("completed broken return");
const completedBroken = IntrinsicPromise.resolve(0);
Object.defineProperty(completedBroken, "constructor", {
	get() {
		throw completedError;
	},
});
rejected(
	"completed return rejects broken Promise",
	completedIterator.next().then(() => completedIterator.return(completedBroken)),
	(reason) => reason === completedError,
);

let genericThrew = false;
let genericPromise;
try {
	genericPromise = basicIterator.next.call({});
} catch {
	genericThrew = true;
}
ok(
	"generic receiver returns exact Promise",
	!genericThrew &&
		genericPromise instanceof IntrinsicPromise &&
		Object.getPrototypeOf(genericPromise) === IntrinsicPromise.prototype,
);
rejected(
	"generic receiver rejects TypeError",
	genericPromise,
	(reason) => reason instanceof TypeError,
);

const realm = new ShadowRealm();
const probeRealmCallbacks = realm.evaluate(`(report) => {
	const realmFunctionPrototype = Function.prototype;
	let callbackShape = false;
	Object.prototype.then = function (resolve, reject) {
		delete Object.prototype.then;
		callbackShape =
			Object.getPrototypeOf(resolve) === realmFunctionPrototype &&
			Object.getPrototypeOf(reject) === realmFunctionPrototype &&
			resolve.name === "" &&
			reject.name === "" &&
			resolve.length === 1 &&
			reject.length === 1;
		resolve(47);
		reject(48);
		resolve(49);
	};
	async function* deferred() {
		await 0;
		yield 5;
	}
	deferred().next().then(
		(value) => report(callbackShape && value === 47),
		() => report(false),
	);
}`);
let releaseRealmCallbacks;
const realmCallbacks = new IntrinsicPromise((resolve) => {
	releaseRealmCallbacks = resolve;
});
probeRealmCallbacks(releaseRealmCallbacks);
fulfilled(
	"deferred direct thenable callbacks use request realm and first call wins",
	realmCallbacks,
	(correct) => correct === true,
);

let releaseReturn;
const returnGate = new IntrinsicPromise((resolve) => {
	releaseReturn = resolve;
});
async function* queuedReturn() {
	await returnGate;
	const sent = yield 19;
	yield sent;
}
const returnIterator = queuedReturn();
const returnQueue = [
	returnIterator.next(),
	returnIterator.next(23),
	returnIterator.return(29),
	returnIterator.next(),
];

let releaseThrow;
const throwGate = new IntrinsicPromise((resolve) => {
	releaseThrow = resolve;
});
async function* queuedThrow() {
	await throwGate;
	try {
		yield 31;
	} catch (reason) {
		yield reason;
	}
	return 37;
}
const queuedThrowReason = { kind: "queued throw" };
const throwIterator = queuedThrow();
const throwQueue = [
	throwIterator.next(),
	throwIterator.throw(queuedThrowReason),
	throwIterator.next(),
];

let releaseMany;
const manyGate = new IntrinsicPromise((resolve) => {
	releaseMany = resolve;
});
async function* many() {
	await manyGate;
	for (let i = 0; i < 64; i++) yield i * 3;
}
const manyIterator = many();
const manyQueue = [];
for (let i = 0; i <= 64; i++)
	manyQueue.push(manyIterator.next().then((result) => result));

if (typeof __mal_collect_garbage === "function") {
	__mal_collect_garbage();
	__mal_collect_garbage();
}
releaseReturn();
releaseThrow();
releaseMany();
releaseAwaitedReturn(59);

fulfilled(
	"awaited return preserves queue order",
	IntrinsicPromise.all(awaitedReturnQueue),
	(results) =>
		results[0].value === 59 &&
		results[0].done === true &&
		results[1].value === undefined &&
		results[1].done === true &&
		results[2].value === 61 &&
		results[2].done === true,
);

fulfilled("pending return queue order", IntrinsicPromise.all(returnQueue), (results) => {
	return (
		results[0].value === 19 &&
		results[0].done === false &&
		results[1].value === 23 &&
		results[1].done === false &&
		results[2].value === 29 &&
		results[2].done === true &&
		results[3].value === undefined &&
		results[3].done === true
	);
});
fulfilled("pending throw queue order", IntrinsicPromise.all(throwQueue), (results) => {
	return (
		results[0].value === 31 &&
		results[0].done === false &&
		results[1].value === queuedThrowReason &&
		results[1].done === false &&
		results[2].value === 37 &&
		results[2].done === true
	);
});
fulfilled(
	"pending next queue survives GC",
	IntrinsicPromise.all(manyQueue),
	(results) => {
		for (let i = 0; i < 64; i++) {
			if (results[i].value !== i * 3 || results[i].done) return false;
		}
		return results[64].value === undefined && results[64].done === true;
	},
);

async function* reentrant() {
	yield 41;
	yield 43;
}
const reentrantIterator = reentrant();
fulfilled(
	"reaction reentrantly requests next",
	reentrantIterator
		.next()
		.then((first) => reentrantIterator.next().then((second) => [first, second])),
	(results) =>
		results[0].value === 41 &&
		results[0].done === false &&
		results[1].value === 43 &&
		results[1].done === false,
);

async function* unhandled() {
	throw new Error("async-generator-direct-unhandled-marker");
}
unhandled().next();

IntrinsicPromise.all(checks).then(() => {
	ok("focused checks ran", passed >= 15);
	console.log("async-generator-direct-promise PASS");
});
