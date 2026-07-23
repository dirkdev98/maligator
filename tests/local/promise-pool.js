let failed = false;
const events = [];
let fulfill;
let reject;
let resolvingMetadata = false;
new Promise((resolve, rejectPromise) => {
	const resolveKeys = Reflect.ownKeys(resolve);
	const rejectKeys = Reflect.ownKeys(rejectPromise);
	const resolveLength = Object.getOwnPropertyDescriptor(resolve, "length");
	const resolveName = Object.getOwnPropertyDescriptor(resolve, "name");
	resolvingMetadata =
		resolve.length === 1 &&
		resolve.name === "" &&
		rejectPromise.length === 1 &&
		rejectPromise.name === "" &&
		resolveKeys[0] === "length" &&
		resolveKeys[1] === "name" &&
		rejectKeys[0] === "length" &&
		rejectKeys[1] === "name" &&
		resolveLength.writable === false &&
		resolveLength.enumerable === false &&
		resolveLength.configurable === true &&
		resolveName.writable === false &&
		resolveName.enumerable === false &&
		resolveName.configurable === true;
	resolve();
});
const fulfilled = new Promise((resolve) => {
	fulfill = resolve;
});
const rejected = new Promise((resolve, rejectPromise) => {
	void resolve;
	reject = rejectPromise;
});

let releaseLarge;
const large = new Promise((resolve) => {
	releaseLarge = resolve;
});
let largeSum = 0;
for (let i = 0; i < 5000; i++) {
	large.then((value) => {
		largeSum += value + i;
	});
}

function abandonPendingReactions() {
	const pending = new Promise(() => {});
	for (let i = 0; i < 1000; i++) pending.then(() => i);
}
abandonPendingReactions();

async function awaitMixedJobs() {
	const value = await Promise.resolve({
		then(resolve) {
			resolve(41);
		},
	});
	return value + 1;
}
const awaited = awaitMixedJobs();

for (let i = 0; i < 64; i++) {
	fulfilled.then(
		(value) => events.push("f" + i + ":" + value),
		() => {
			failed = true;
		},
	);
	rejected.then(
		() => {
			failed = true;
		},
		(value) => events.push("r" + i + ":" + value),
	);
}

fulfill("ok");
reject("bad");
releaseLarge(3);

const gc = globalThis.__mal_collect_garbage;
let chain = Promise.resolve(0);
for (let i = 0; i < 128; i++) {
	chain = chain.then((value) => {
		if (typeof gc === "function" && i % 17 === 0) gc();
		if ((i & 1) === 0) {
			return {
				then(resolve) {
					if (typeof gc === "function" && i % 19 === 0) gc();
					resolve(value + 1);
				},
			};
		}
		return value + 1;
	});
}

Promise.all([chain, awaited]).then(([value, awaitedValue]) => {
	Promise.resolve().then(() => {
		if (
			failed ||
			!resolvingMetadata ||
			value !== 128 ||
			awaitedValue !== 42 ||
			events.length !== 128 ||
			largeSum !== 12512500
		) {
			throw new Error("promise pool state mismatch");
		}
		for (let i = 0; i < 64; i++) {
			if (events[i] !== "f" + i + ":ok" || events[i + 64] !== "r" + i + ":bad") {
				throw new Error("promise reaction pairing/order mismatch at " + i);
			}
		}
		console.log("promise-pool PASS");
	});
});
