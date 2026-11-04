import { AsyncLocalStorage } from "node:async_hooks";

const cases = {
	async settled() {
		const values = await Promise.all([
			Promise.resolve(1),
			Promise.resolve(2),
			Promise.resolve(3),
		]);
		return {
			values,
			keys: Object.keys(values),
			prototype: Object.getPrototypeOf(values) === Array.prototype,
		};
	},
	async pending() {
		let first, second;
		const inputs = [
			new Promise((resolve) => {
				first = resolve;
			}),
			new Promise((resolve) => {
				second = resolve;
			}),
		];
		const result = Promise.all(inputs);
		second(22);
		first(11);
		return await result;
	},
	async duplicates() {
		let finish;
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const inputs = [pending, pending, Promise.resolve(9)];
		const result = Promise.all(inputs);
		finish(7);
		return { values: await result, inputCount: inputs.length };
	},
	async changedInput() {
		let finish;
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const inputs = [Promise.resolve({ value: 11 }), pending];
		const result = Promise.all(inputs);
		inputs[0] = Promise.resolve({ value: 99 });
		inputs.length = 0;
		await 0;
		finish({ value: 22 });
		return await result;
	},
	async context() {
		const storage = new AsyncLocalStorage();
		let finish;
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const result = storage.run("aggregate", () =>
			Promise.all([pending]).then((values) => ({ values, store: storage.getStore() })),
		);
		storage.run("settler", () => finish(7));
		return await result;
	},
	async ordering() {
		const events = [];
		const source = Promise.resolve(3);
		source.then(() => events.push("before"));
		const result = Promise.all([source, source]);
		source.then(() => events.push("after"));
		result.then((values) => events.push(values.join(",")));
		events.push("sync");
		await result;
		events.push("await");
		return events;
	},
	async empty() {
		const events = [];
		const result = Promise.all([]);
		result.then((values) => events.push(`all:${values.length}`));
		Promise.resolve().then(() => events.push("other"));
		await result;
		events.push("await");
		return events;
	},
	async rejection() {
		let reject;
		const first = new Promise((_resolve, fail) => {
			reject = fail;
		});
		const second = Promise.reject("second");
		const result = Promise.all([first, second, first]);
		reject("first");
		try {
			await result;
		} catch (error) {
			return error;
		}
	},
	async retained() {
		let finish,
			payload = { label: "retained", nested: { value: 71 } };
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const result = Promise.all([Promise.resolve(payload), pending]);
		payload = null;
		await 0;
		const pressure = [];
		for (let index = 0; index < 512; index++)
			pressure.push({ index, values: [index, index + 1] });
		finish(pressure.length);
		return await result;
	},
	async specialValues() {
		const values = await Promise.all([
			Promise.resolve(NaN),
			Promise.resolve(-0),
			Promise.resolve(Infinity),
			Promise.resolve(9n),
			Promise.resolve(Symbol.for("dense-all")),
		]);
		return [
			Number.isNaN(values[0]),
			Object.is(values[1], -0),
			values[2] === Infinity,
			values[3] === 9n,
			values[4] === Symbol.for("dense-all"),
		];
	},
	async holes() {
		const values = await Promise.all(new Array(2));
		return { values, keys: Object.keys(values) };
	},
	async accessorIndex() {
		const events = [],
			inputs = [Promise.resolve(1), Promise.resolve(2)];
		Object.defineProperty(inputs, "0", {
			get() {
				events.push("index");
				inputs[1] = Promise.resolve(8);
				return Promise.resolve(4);
			},
		});
		return { values: await Promise.all(inputs), events };
	},
	async observedThen() {
		const events = [],
			source = Promise.resolve(4),
			then = source.then;
		Object.defineProperty(source, "then", {
			get() {
				events.push("then");
				return then;
			},
		});
		return { values: await Promise.all([Promise.resolve(1), source]), events };
	},
	async observedConstructor() {
		const events = [],
			source = Promise.resolve(4);
		Object.defineProperty(source, "constructor", {
			get() {
				events.push("constructor");
				return Promise;
			},
		});
		return { values: await Promise.all([source]), events };
	},
	async customIterator() {
		const events = [],
			inputs = [];
		inputs[Symbol.iterator] = function () {
			events.push("iterator");
			let index = 0;
			return {
				next() {
					events.push(`next:${index}`);
					return index++ < 2
						? { done: false, value: Promise.resolve(index * 3) }
						: { done: true };
				},
			};
		};
		return { values: await Promise.all(inputs), events };
	},
	async iteratorClose() {
		const events = [],
			source = Promise.resolve(3),
			inputs = [];
		Object.defineProperty(source, "then", {
			get() {
				events.push("then");
				throw "then failed";
			},
		});
		inputs[Symbol.iterator] = () => ({
			next() {
				return { done: false, value: source };
			},
			return() {
				events.push("close");
				return {};
			},
		});
		let error;
		try {
			await Promise.all(inputs);
		} catch (caught) {
			error = caught;
		}
		return { error, events };
	},
	async subclass() {
		const events = [];
		class SourcePromise extends Promise {
			static get [Symbol.species]() {
				events.push("species");
				return Promise;
			}
		}
		const values = await Promise.all([SourcePromise.resolve(5)]);
		return { values, events };
	},
	async customResult() {
		class ResultPromise extends Promise {}
		const result = ResultPromise.all([Promise.resolve(3), 4]);
		return { values: await result, subclass: result instanceof ResultPromise };
	},
	async lateThen() {
		let finish;
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const result = Promise.all([pending]);
		Object.defineProperty(Array.prototype, "then", {
			configurable: true,
			value(resolve) {
				resolve("intercepted");
			},
		});
		finish(1);
		try {
			return await result;
		} finally {
			delete Array.prototype.then;
		}
	},
	async resolveOverride() {
		const events = [],
			original = Object.getOwnPropertyDescriptor(Promise, "resolve");
		Object.defineProperty(Promise, "resolve", {
			configurable: true,
			get() {
				events.push("resolve");
				return function (value) {
					events.push(`call:${value}`);
					return {
						then(onFulfilled) {
							onFulfilled(value * 2);
						},
					};
				};
			},
		});
		try {
			return { values: await Promise.all([2, 3]), events };
		} finally {
			Object.defineProperty(Promise, "resolve", original);
		}
	},
};

console.log(JSON.stringify(await cases[process.env.PROMISE_ALL_CASE ?? "settled"]()));
