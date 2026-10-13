"use strict";
const kind = process.env.FROM_ASYNC_KIND || "sync";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function assert(value, message) {
	if (!value) throw new Error(message);
}
async function main() {
	if (kind === "sync") {
		const log = [];
		const receiver = { factor: 3 };
		const source = {
			get [Symbol.asyncIterator]() {
				collectGarbage();
				log.push("async");
				return undefined;
			},
			get [Symbol.iterator]() {
				collectGarbage();
				log.push("sync");
				return function () {
					let index = 0;
					return {
						get next() {
							collectGarbage();
							log.push("next-get");
							return function () {
								collectGarbage();
								log.push(`next${index}`);
								return index < 3
									? { value: Promise.resolve({ n: ++index }), done: false }
									: { done: true };
							};
						},
					};
				};
			},
		};
		function Result() {
			collectGarbage();
			assert(arguments.length === 0, "iterable constructor arity");
			log.push("construct");
		}
		const offset = 7;
		function mapper(value, index, missing = 42) {
			collectGarbage();
			assert(
				this === receiver &&
					arguments.length === 2 &&
					missing === 42 &&
					typeof value.n === "number",
				"sync mapper ABI",
			);
			log.push(`map${index}`);
			const mapped = value.n * this.factor + index + offset;
			return {
				then(resolve) {
					collectGarbage();
					log.push(`await${index}`);
					resolve(mapped);
				},
			};
		}
		const result = await Array.fromAsync.call(Result, source, mapper, receiver);
		assert(
			result instanceof Result &&
				result.length === 3 &&
				result[0] === 10 &&
				result[2] === 18,
			"sync mapped result",
		);
		assert(
			log.join(",") ===
				"async,sync,next-get,construct,next0,map0,await0,next1,map1,await1,next2,map2,await2,next3",
			"sequential await order",
		);
		console.log("sync", result[0], result[1], result[2], log.join(","));
	} else if (kind === "async") {
		const log = [];
		const source = {
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					get next() {
						collectGarbage();
						return function () {
							const current = index++;
							log.push(`next${current}`);
							return Promise.resolve(
								current < 2
									? {
											get done() {
												collectGarbage();
												return false;
											},
											get value() {
												collectGarbage();
												return Promise.resolve({ n: current + 4 });
											},
										}
									: { done: true },
							);
						};
					},
				};
			},
		};
		const result = await Array.fromAsync(source, function (value, index) {
			collectGarbage();
			assert(
				value instanceof Promise && this === undefined && arguments.length === 2,
				"async iterator value is not awaited before mapper",
			);
			log.push(`map${index}`);
			return value.then((item) => item.n + index);
		});
		assert(
			result.join(",") === "4,6" && log.join(",") === "next0,map0,next1,map1,next2",
			"async ordering",
		);
		console.log("async", result.join(","), log.join(","));
	} else if (kind === "arrayLike") {
		const log = [];
		const source = {
			get [Symbol.asyncIterator]() {
				collectGarbage();
				log.push("async");
				return undefined;
			},
			get [Symbol.iterator]() {
				collectGarbage();
				log.push("sync");
				return undefined;
			},
			get length() {
				log.push("length");
				return {
					valueOf() {
						collectGarbage();
						log.push("number");
						return 3;
					},
				};
			},
			get 0() {
				collectGarbage();
				log.push("get0");
				return Promise.resolve(2);
			},
			get 1() {
				collectGarbage();
				log.push("get1");
				return 4;
			},
			2: 6,
		};
		function Result(length) {
			collectGarbage();
			assert(arguments.length === 1 && length === 3, "arraylike constructor arity");
			log.push("construct");
		}
		const receiver = { factor: 5 };
		const result = await Array.fromAsync.call(
			Result,
			source,
			function (value, index) {
				collectGarbage();
				assert(this === receiver && arguments.length === 2, "arraylike ABI");
				log.push(`map${index}`);
				if (index === 0) source[2] = 8;
				return Promise.resolve(value * this.factor + index);
			},
			receiver,
		);
		assert(
			result instanceof Result && result.length === 3 && result[2] === 42,
			"arraylike live values",
		);
		console.log("arrayLike", result[0], result[1], result[2], log.join(","));
	} else if (kind === "reentry") {
		const receiver = { marker: 7 };
		let calls = 0;
		function mapper(value, index) {
			collectGarbage();
			assert(this === receiver && arguments.length === 2, "nested mapper receiver");
			calls++;
			if (value === 1)
				return Array.fromAsync([5, 6], mapper, receiver).then(
					(values) => values[0] + values[1],
				);
			return value;
		}
		const result = await Array.fromAsync([1, 2], mapper, receiver);
		assert(result.join(",") === "11,2" && calls === 4, "suspended nested mapper state");
		console.log("reentry", result.join(","), calls);
	} else if (kind === "abrupt") {
		const marker = { thrown: true };
		let closes = 0;
		function iterable(async, nextThrows) {
			return {
				[async ? Symbol.asyncIterator : Symbol.iterator]() {
					return {
						next() {
							collectGarbage();
							if (nextThrows) throw marker;
							return { value: 1, done: false };
						},
						return() {
							collectGarbage();
							closes++;
							if (async) throw new Error("secondary close");
							return {};
						},
					};
				},
			};
		}
		try {
			await Array.fromAsync(iterable(false, false), function () {
				collectGarbage();
				throw marker;
			});
			throw new Error("missing mapper throw");
		} catch (error) {
			assert(error === marker && closes === 1, "sync mapper close precedence");
		}
		try {
			await Array.fromAsync(iterable(true, false), function () {
				return Promise.reject(marker);
			});
			throw new Error("missing map rejection");
		} catch (error) {
			assert(error === marker && closes === 2, "async mapper close precedence");
		}
		try {
			await Array.fromAsync(iterable(true, true), function (value) {
				return value;
			});
			throw new Error("missing next throw");
		} catch (error) {
			assert(error === marker && closes === 2, "next failure must not close");
		}
		console.log("abrupt", closes);
	} else if (kind === "freshErrors") {
		let closes = 0;
		function source() {
			return {
				[Symbol.asyncIterator]() {
					return {
						next() {
							return Promise.resolve({ value: 4, done: false });
						},
						get return() {
							collectGarbage();
							return function () {
								collectGarbage();
								closes++;
								return {};
							};
						},
					};
				},
			};
		}
		try {
			await Array.fromAsync(source(), function () {
				throw { tag: "fresh", payload: { value: 37 } };
			});
			throw new Error("missing fresh throw");
		} catch (error) {
			assert(
				error.tag === "fresh" && error.payload.value === 37,
				"fresh throw survives close",
			);
		}
		try {
			await Array.fromAsync(source(), function () {
				return Promise.reject({ tag: "rejected", payload: { value: 41 } });
			});
			throw new Error("missing fresh rejection");
		} catch (error) {
			assert(
				error.tag === "rejected" && error.payload.value === 41,
				"fresh rejection survives close",
			);
		}
		function Result() {
			Object.preventExtensions(this);
		}
		try {
			await Array.fromAsync.call(Result, source(), function (value) {
				return value;
			});
			throw new Error("missing define error");
		} catch (error) {
			assert(
				error instanceof TypeError &&
					typeof error.message === "string" &&
					error.message.length > 0,
				"define error survives close",
			);
		}
		assert(closes === 3, "fresh errors close once");
		console.log("freshErrors", closes);
	} else if (kind === "acquisition") {
		const marker = {};
		let calls = 0;
		function mapper(value) {
			calls++;
			return value;
		}
		for (const source of [
			{
				get [Symbol.asyncIterator]() {
					collectGarbage();
					throw marker;
				},
			},
			{
				[Symbol.asyncIterator]() {
					return {
						get next() {
							collectGarbage();
							throw marker;
						},
					};
				},
			},
			{
				get length() {
					return {
						valueOf() {
							collectGarbage();
							throw marker;
						},
					};
				},
			},
		]) {
			let promise;
			try {
				promise = Array.fromAsync(source, mapper);
			} catch {
				throw new Error("synchronous throw escaped");
			}
			try {
				await promise;
				throw new Error("missing acquisition rejection");
			} catch (error) {
				assert(error === marker, "acquisition error identity");
			}
		}
		assert(calls === 0, "mapper ran before acquisition");
		console.log("acquisition", calls);
	} else if (kind === "fallbacks") {
		const asyncResult = await Array.fromAsync([1, 2], async function (value) {
			collectGarbage();
			return value + 1;
		});
		const receiver = { factor: 3 };
		const bound = function (value) {
			collectGarbage();
			return value * this.factor;
		}.bind(receiver);
		const boundResult = await Array.fromAsync([2, 3], bound);
		const proxy = new Proxy(
			function (value, index) {
				return value + index;
			},
			{
				apply(target, receiver, args) {
					collectGarbage();
					return Reflect.apply(target, receiver, args);
				},
			},
		);
		const proxyResult = await Array.fromAsync([3, 4], proxy);
		assert(
			asyncResult.join(",") === "2,3" &&
				boundResult.join(",") === "6,9" &&
				proxyResult.join(",") === "3,5",
			"unsupported mapper fallbacks",
		);
		console.log(
			"fallbacks",
			asyncResult.join(","),
			boundResult.join(","),
			proxyResult.join(","),
		);
	} else throw new Error("unknown fromAsync mode");
}
main().catch((error) => {
	console.log("FAIL", String(error));
});
