const events = [];
async function direct(value) {
	events.push(`direct ${value}`);
	return value;
}
async function suspended(label, value) {
	events.push(`${label} start`);
	const result = await value;
	events.push(`${label} resumed ${result}`);
	await 0;
	events.push(`${label} end`);
	return result;
}
async function adopted(value) {
	return value;
}
async function rejected() {
	events.push("reject body");
	throw new Error("activation");
}
async function conditional(suspend) {
	const record = { label: "rowan" };
	if (suspend) await 0;
	return record.label;
}

const thenable = {
	get then() {
		events.push("thenable getter");
		return (resolve, reject) => {
			events.push("thenable call");
			queueMicrotask(() => events.push("thenable queued"));
			resolve("thenable");
			reject("ignored");
			resolve("ignored");
		};
	},
};
const settled = Promise.resolve("native");
const pending = [
	direct("value").then((value) => events.push(`direct then ${value}`)),
	suspended("primitive", 7),
	suspended("promise", settled),
	suspended("thenable", thenable),
	adopted(settled).then((value) => events.push(`adopted ${value}`)),
	adopted(thenable).then((value) => events.push(`adopted ${value}`)),
	conditional(false).then((value) => events.push(`immediate ${value}`)),
	conditional(true).then((value) => events.push(`suspended ${value}`)),
];
try {
	pending.push(rejected().catch((error) => events.push(`rejected ${error.message}`)));
	events.push("reject returned");
} catch {
	events.push("reject threw synchronously");
}
settled.then(() => events.push("settled then"));
queueMicrotask(() => events.push("queued first"));
Promise.resolve().then(() => {
	events.push("reaction");
	queueMicrotask(() => events.push("queued in reaction"));
});
events.push("synchronous end");
await Promise.all(pending);
console.log(events.join("\n"));

async function argumentsAfterSuspension(first, ...rest) {
	const original = arguments;
	first += 1;
	await 0;
	return [first, rest.join(","), original[0], arguments.length].join("|");
}
async function retainedAcrossSuspension(input) {
	const a = { value: input + 1 };
	const b = { value: input + 2 };
	const c = { value: input + 3 };
	await Promise.resolve();
	const saved = a.value + b.value + c.value;
	await 0;
	return saved + a.value;
}
console.log("arguments", await argumentsAfterSuspension(3, 5, 8));
console.log("retained", await retainedAcrossSuspension(10));

const throwingConstructor = Promise.resolve(1);
Object.defineProperty(throwingConstructor, "constructor", {
	get() {
		throw new RangeError("constructor");
	},
});
try {
	await suspended("constructor", throwingConstructor);
} catch (error) {
	console.log("constructor rejection", error.name, error.message);
}
const throwingThen = {
	get then() {
		throw new TypeError("then");
	},
};
try {
	await adopted(throwingThen);
} catch (error) {
	console.log("then rejection", error.name, error.message);
}

async function resolvedPrimitive(value) {
	return await Promise.resolve(value);
}
console.log("resolved primitive", await resolvedPrimitive(17));
console.log("resolved object", (await resolvedPrimitive({ label: "birch" })).label);
console.log("resolved promise", await resolvedPrimitive(Promise.resolve(19)));
console.log(
	"resolved thenable",
	await resolvedPrimitive({
		then(resolve) {
			resolve(23);
		},
	}),
);

const pendingEvents = [];
let releasePending;
const sharedPending = new Promise((resolve) => {
	releasePending = resolve;
});
async function awaitShared(label) {
	pendingEvents.push(`${label} start`);
	const value = await sharedPending;
	pendingEvents.push(`${label} resumed ${value}`);
	queueMicrotask(() => pendingEvents.push(`${label} queued`));
	return value;
}
const sharedFirst = awaitShared("first");
sharedPending.then((value) => pendingEvents.push(`then ${value}`));
const sharedSecond = awaitShared("second");
queueMicrotask(() => {
	pendingEvents.push("before settlement");
	releasePending(29);
	queueMicrotask(() => pendingEvents.push("after settlement"));
});
await Promise.all([sharedSecond, sharedFirst, sharedPending]);
await awaitShared("settled");
console.log("pending order", pendingEvents.join("|"));

const releases = [];
const retainedResults = [];
async function retainedBatch(index) {
	const label = { value: index };
	await new Promise((resolve) => releases.push(resolve));
	await 0;
	return label.value;
}
for (let index = 0; index < 80; index++) retainedResults.push(retainedBatch(index));
for (let index = releases.length - 1; index >= 0; index--) releases[index]();
const retainedValues = await Promise.all(retainedResults);
let reusedChecksum = 0;
for (let index = 0; index < 80; index++) {
	reusedChecksum += await retainedAcrossSuspension(index);
	reusedChecksum += await argumentsAfterSuspension(index, index + 1).then((value) =>
		Number(value.split("|")[0]),
	);
}
console.log(
	"retained results",
	retainedValues.join(","),
	(await Promise.all(retainedResults)).join(","),
	reusedChecksum,
);

const reentryEvents = [];
async function reentered() {
	reentryEvents.push("nested start");
	await 0;
	reentryEvents.push("nested end");
	return 31;
}
let nestedResult;
async function returningThenable() {
	await 0;
	return {
		get then() {
			reentryEvents.push("return getter");
			nestedResult = reentered();
			return (resolve) => {
				reentryEvents.push("return then");
				resolve(nestedResult);
			};
		},
	};
}
console.log("reentry result", await returningThenable(), await nestedResult);
console.log("reentry order", reentryEvents.join("|"));

const collect = Reflect.get(globalThis, "__mal_collect_garbage");
await retainedAcrossSuspension(5);
if (typeof collect === "function") collect();
const detachedValues = [];
async function detached(value) {
	const record = { value };
	if (typeof collect === "function") collect();
	await 0;
	if (typeof collect === "function") collect();
	await 0;
	detachedValues.push(record.value);
}
function launchDetached(value) {
	detached(value);
}
for (let index = 0; index < 24; index++) launchDetached(index);
await 0;
await 0;
await 0;
console.log("detached results", detachedValues.join(","));

async function mixedChild(value) {
	const record = { value };
	await 0;
	if (typeof collect === "function") collect();
	return record;
}
async function* mixedGenerator(value) {
	try {
		yield await mixedChild(value);
		return await mixedChild(value + 1);
	} finally {
		await 0;
	}
}
let mixedChecksum = 0;
for (let index = 0; index < 80; index++) {
	const iterator = mixedGenerator(index);
	const first = await iterator.next();
	const second = await iterator.next();
	if (first.done || !second.done) throw new Error("mixed async completion differs");
	mixedChecksum += first.value.value + second.value.value;
}
console.log("mixed await", mixedChecksum);
