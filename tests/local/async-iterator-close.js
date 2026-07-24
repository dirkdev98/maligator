let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function asyncIterator(returnDescriptor) {
	const iterator = {
		next() {
			return Promise.resolve({ value: 1, done: false });
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
	if (returnDescriptor) Object.defineProperty(iterator, "return", returnDescriptor);
	return iterator;
}

async function main() {
	{
		const events = [];
		const source = asyncIterator({
			value() {
				events.push("return");
				return {
					then(resolve) {
						events.push("then");
						Promise.resolve().then(() => {
							events.push("settled");
							resolve({ done: true });
						});
					},
				};
			},
			configurable: true,
		});
		for await (const value of source) {
			ok("break body", value === 1);
			break;
		}
		events.push("after");
		ok("break awaits thenable return", events.join(",") === "return,then,settled,after");
	}

	{
		let error;
		try {
			for await (const value of asyncIterator({ value: () => 1 })) break;
		} catch (caught) {
			error = caught;
		}
		ok("fulfilled primitive rejects", error instanceof TypeError);
	}

	{
		const closeError = { kind: "close rejection" };
		let error;
		let closes = 0;
		try {
			for await (const value of asyncIterator({
				value() {
					closes++;
					return Promise.reject(closeError);
				},
			}))
				break;
		} catch (caught) {
			error = caught;
		}
		ok("normal close rejection identity", error === closeError);
		ok("failed close is single shot", closes === 1);
	}

	{
		const getterError = { kind: "getter" };
		let error;
		try {
			for await (const value of asyncIterator({
				get() {
					throw getterError;
				},
			}))
				break;
		} catch (caught) {
			error = caught;
		}
		ok("normal getter failure identity", error === getterError);
	}

	{
		let missingCompleted = false;
		for await (const value of asyncIterator()) break;
		missingCompleted = true;
		const source = asyncIterator({ value: null });
		for await (const value of source) break;
		ok("missing and null return are no-op", missingCompleted);
	}

	{
		const original = { kind: "original" };
		const events = [];
		let error;
		try {
			for await (const value of asyncIterator({
				value() {
					events.push("return");
					return {
						then(_resolve, reject) {
							Promise.resolve().then(() => {
								events.push("rejected");
								reject({ kind: "secondary" });
							});
						},
					};
				},
			}))
				throw original;
		} catch (caught) {
			error = caught;
			events.push("caught");
		}
		ok("throw wins over awaited close rejection", error === original);
		ok("throw waits for rejected close", events.join(",") === "return,rejected,caught");
	}

	{
		const original = { kind: "original getter" };
		let error;
		try {
			for await (const value of asyncIterator({
				get() {
					throw { kind: "secondary" };
				},
			})) {
				throw original;
			}
		} catch (caught) {
			error = caught;
		}
		ok("throw wins over getter failure", error === original);
	}

	{
		const events = [];
		const inner = asyncIterator({
			value() {
				return Promise.resolve().then(() => {
					events.push("inner");
					return {};
				});
			},
		});
		const outer = asyncIterator({
			value() {
				return Promise.resolve().then(() => {
					events.push("outer");
					return {};
				});
			},
		});
		outerLoop: for await (const outerValue of outer) {
			for await (const innerValue of inner) break outerLoop;
		}
		ok("nested cleanup is awaited inside out", events.join(",") === "inner,outer");
	}

	{
		const events = [];
		const source = asyncIterator({
			value() {
				return Promise.resolve().then(() => {
					events.push("closed");
					return {};
				});
			},
		});
		async function returnFromLoop() {
			for await (const value of source) return 17;
		}
		ok(
			"async return waits for close",
			(await returnFromLoop()) === 17 && events[0] === "closed",
		);
	}

	{
		const events = [];
		const source = asyncIterator({
			value() {
				return Promise.resolve().then(() => {
					events.push("closed");
					return {};
				});
			},
		});
		async function* generator() {
			for await (const value of source) yield value;
		}
		const iterator = generator();
		const first = await iterator.next();
		const returned = await iterator.return(23);
		ok(
			"async generator return closes and awaits",
			first.value === 1 && returned.value === 23 && events[0] === "closed",
		);
	}

	{
		const original = { retained: "original across close await" };
		let error;
		try {
			for await (const value of asyncIterator({
				value() {
					return Promise.resolve().then(() => {
						if (typeof __mal_collect_garbage === "function") {
							__mal_collect_garbage();
							__mal_collect_garbage();
						}
						return {};
					});
				},
			}))
				throw original;
		} catch (caught) {
			error = caught;
		}
		ok(
			"original throw is rooted across close await",
			error === original && error.retained.length === 27,
		);
	}

	ok("focused checks ran", passed === 14);
	console.log("async-iterator-close PASS " + passed + "/" + passed);
}

main();
