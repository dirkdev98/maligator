const method = process.env.DENSE_COMBINATOR_METHOD;
const scenario = process.env.DENSE_COMBINATOR_CASE;
const combine = (values) => Promise[method](values);
async function outcome(promise) {
	try {
		return { fulfilled: await promise };
	} catch (error) {
		return {
			rejected:
				error instanceof Error ? { name: error.name, errors: error.errors } : error,
		};
	}
}
const cases = {
	rejected: () => outcome(combine([Promise.reject(5), Promise.reject(9)])),
	settled: () =>
		outcome(combine([Promise.reject(3), Promise.resolve(7), Promise.resolve(11)])),
	async pending() {
		let first, second;
		const inputs = [
			new Promise((resolve) => {
				first = resolve;
			}),
			new Promise((_, reject) => {
				second = reject;
			}),
		];
		const promise = combine(inputs);
		second(13);
		first(17);
		return outcome(promise);
	},
	pendingDuplicates() {
		let release;
		const input = new Promise((resolve) => {
			release = resolve;
		});
		const promise = combine([input, input, input]);
		release({ label: "willow" });
		return outcome(promise);
	},
	duplicates() {
		const value = Promise.resolve({ label: "rowan" });
		return outcome(combine([value, value, value]));
	},
	async empty() {
		const promise = combine([]);
		if (method !== "race") return outcome(promise);
		let settled = false;
		promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await 0;
		await 0;
		return { settled };
	},
	async ordering() {
		const events = [];
		const input = Promise.resolve(19);
		input.then(() => events.push("before"));
		const promise = combine([input, input]);
		promise.then(() => events.push("result"));
		input.then(() => events.push("after"));
		const result = await outcome(promise);
		return { result, events };
	},
	async retained() {
		let release;
		const inputs = [
			Promise.resolve({ label: "birch" }),
			new Promise((resolve) => {
				release = resolve;
			}),
		];
		const promise = combine(inputs);
		queueMicrotask(() => release({ label: "cedar" }));
		return outcome(promise);
	},
	changedInput() {
		const inputs = [Promise.resolve(23), Promise.resolve(29)];
		const promise = combine(inputs);
		inputs[0] = inputs[1] = Promise.resolve(97);
		return outcome(promise);
	},
	holes: () => outcome(combine(new Array(2))),
	async accessor() {
		const events = [];
		const inputs = [Promise.resolve(31), Promise.resolve(37)];
		Object.defineProperty(inputs, "0", {
			get() {
				events.push("index");
				inputs[1] = Promise.resolve(41);
				return Promise.resolve(43);
			},
		});
		return { result: await outcome(combine(inputs)), events };
	},
	async ownIterator() {
		const events = [];
		const inputs = [];
		inputs[Symbol.iterator] = function* () {
			events.push("iterator");
			yield Promise.resolve(47);
			yield Promise.resolve(53);
		};
		return { result: await outcome(combine(inputs)), events };
	},
	async observedConstructor() {
		const events = [];
		const input = Promise.resolve(59);
		Object.defineProperty(input, "constructor", {
			get() {
				events.push("constructor");
				return Promise;
			},
		});
		return { result: await outcome(combine([input])), events };
	},
	async replacedResolve() {
		const resolve = Promise.resolve;
		const events = [];
		Promise.resolve = function (value) {
			events.push("resolve");
			return resolve.call(this, value);
		};
		try {
			return { result: await outcome(combine([61, 67])), events };
		} finally {
			Promise.resolve = resolve;
		}
	},
	async lateThen() {
		const events = [];
		const value = { label: "first" };
		const promise = combine([Promise.resolve(value), Promise.resolve("second")]);
		Object.defineProperty(value, "then", {
			get() {
				events.push("get then");
				return (resolve) => {
					events.push("call then");
					queueMicrotask(() => resolve("adopted first"));
				};
			},
		});
		return { result: await outcome(promise), events };
	},
	async lateArrayThen() {
		const events = [];
		const promise = combine([Promise.resolve(71), Promise.resolve(73)]);
		Object.defineProperty(Array.prototype, "then", {
			configurable: true,
			get() {
				events.push(this.length);
				return (resolve) => resolve("adopted Array");
			},
		});
		try {
			return { result: await outcome(promise), events };
		} finally {
			delete Array.prototype.then;
		}
	},
	async subclass() {
		class Result extends Promise {}
		const promise = Result[method]([Promise.resolve(79), Promise.resolve(83)]);
		return { subclass: promise instanceof Result, result: await outcome(promise) };
	},
};
console.log(JSON.stringify(await cases[scenario]()));
