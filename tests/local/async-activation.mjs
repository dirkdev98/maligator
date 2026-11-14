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
