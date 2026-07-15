let failed = false;
const events = [];
let fulfill;
let reject;
const fulfilled = new Promise((resolve) => {
	fulfill = resolve;
});
const rejected = new Promise((resolve, rejectPromise) => {
	void resolve;
	reject = rejectPromise;
});

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

chain.then((value) => {
	Promise.resolve().then(() => {
		if (failed || value !== 128 || events.length !== 128) {
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
