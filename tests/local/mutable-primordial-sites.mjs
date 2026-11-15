const original = { Date, Object, Symbol, create: Object.create, parse: Date.parse };
const text = "2023-11-14T22:13:20.000Z";

function format(value, digits) {
	const text = (+value).toFixed(digits);
	return [text, Number.parseFloat(text)];
}

function entriesMarker(value) {
	let result = "";
	for (const [key, entry] of Object.entries(value)) result += `${key}:${entry}`;
	return result;
}

function sample() {
	const methods = { [Symbol.iterator]() {} };
	return [
		Date.parse(text),
		Date.now() > 0,
		Date.UTC(2020, 0),
		Object.create({ marker: 7 }).marker,
		entriesMarker({ marker: 7 }),
		methods[Symbol.iterator].name,
		format(7.25, 2),
	];
}

function fakeDate() {
	return {
		parse(value) {
			return this === globalThis.Date && value === text ? 19 : -1;
		},
		now: () => -1,
		UTC: (year) => year + 3,
	};
}

function spreadSharedLiteral(first, second, left = 2, right = 3) {
	const values = [left, right];
	const initial = +first(...values);
	return [initial, second(...values)];
}

function sum(left = 0, right = 0) {
	return left + right;
}

function reduceRest(base, ...values) {
	let total = base;
	for (const value of values) total += value;
	return total;
}

const cases = {
	"numeric rest sum observes an iterator changed after first use"() {
		const warm = reduceRest(3, 5, 7);
		const original = Array.prototype[Symbol.iterator];
		try {
			Array.prototype[Symbol.iterator] = function () {
				let done = false;
				return {
					next() {
						const previous = done;
						done = true;
						return { value: 43, done: previous };
					},
				};
			};
			return [warm, reduceRest(3, 5, 7)];
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
	},
	"numeric rest fallback coerces once and closes on throw"() {
		const warm = reduceRest(3, 5, 7);
		const prototype = Object.getPrototypeOf([][Symbol.iterator]());
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "return");
		const marker = {};
		let calls = 0;
		let closes = 0;
		try {
			try {
				reduceRest(
					1,
					2,
					{
						valueOf() {
							calls++;
							prototype.return = function () {
								closes++;
								return { done: true };
							};
							throw marker;
						},
					},
					4,
				);
			} catch (error) {
				return [warm, error === marker, calls, closes];
			}
			throw new Error("missing reduction throw");
		} finally {
			if (descriptor === undefined) delete prototype.return;
			else Object.defineProperty(prototype, "return", descriptor);
		}
	},
	"shared literal iterator changes after its first spread"() {
		const warm = spreadSharedLiteral(sum, sum);
		const original = Array.prototype[Symbol.iterator];
		try {
			const result = spreadSharedLiteral((left, right) => {
				Array.prototype[Symbol.iterator] = function () {
					let done = false;
					return {
						next() {
							const previous = done;
							done = true;
							return { value: 41, done: previous };
						},
					};
				};
				return left + right;
			}, sum);
			return [warm, result];
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
	},
	"shared literal fallback retains identity and element writes"() {
		const warm = spreadSharedLiteral(sum, sum);
		const original = Array.prototype[Symbol.iterator];
		let saved;
		let reads = 0;
		try {
			Array.prototype[Symbol.iterator] = function () {
				if (saved !== undefined && saved !== this) throw new Error("literal identity");
				saved = this;
				this[reads++] = reads * 17;
				return original.call(this);
			};
			const result = spreadSharedLiteral(sum, sum);
			return [warm, result, reads, saved[0], saved[1]];
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
	},
	"shared literal coercion changes the following iterator getter"() {
		const warm = spreadSharedLiteral(sum, sum);
		const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
		let reads = 0;
		try {
			const result = spreadSharedLiteral(
				() => ({
					valueOf() {
						Object.defineProperty(Array.prototype, Symbol.iterator, {
							configurable: true,
							get() {
								reads++;
								this[0] = 29;
								return descriptor.value;
							},
						});
						return 7;
					},
				}),
				sum,
			);
			return [warm, result, reads];
		} finally {
			Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
		}
	},
	"shared literal next changes after its first spread"() {
		const warm = spreadSharedLiteral(sum, sum);
		const prototype = Object.getPrototypeOf([][Symbol.iterator]());
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "next");
		let steps = 0;
		try {
			const result = spreadSharedLiteral((left, right) => {
				prototype.next = function () {
					return { value: 37, done: steps++ > 0 };
				};
				return left + right;
			}, sum);
			return [warm, result, steps];
		} finally {
			Object.defineProperty(prototype, "next", descriptor);
		}
	},
	"shared literal iterator throw preserves the preceding call"() {
		const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
		let saved;
		let reads = 0;
		let calls = 0;
		try {
			Object.defineProperty(Array.prototype, Symbol.iterator, {
				configurable: true,
				get() {
					reads++;
					if (reads === 2) throw this === saved ? "same literal" : "different literal";
					saved = this;
					return descriptor.value;
				},
			});
			try {
				spreadSharedLiteral((left, right) => {
					calls++;
					return left + right;
				}, sum);
			} catch (error) {
				return [error, reads, calls];
			}
			throw new Error("missing iterator throw");
		} finally {
			Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
		}
	},
	"format method before first call"() {
		Number.prototype.toFixed = () => "53.5";
		return sample();
	},
	"format method after first call"() {
		const first = sample();
		Number.prototype.toFixed = () => "59.5";
		return [first, sample()];
	},
	"format coercion changes the following parser"() {
		const first = sample();
		const result = format(7.25, {
			valueOf() {
				Number.parseFloat = () => 61;
				return 2;
			},
		});
		return [first, result, sample()];
	},
	"format coercion preserves the captured method"() {
		const first = sample();
		const result = format(7.25, {
			valueOf() {
				Number.prototype.toFixed = () => "67.5";
				return 2;
			},
		});
		return [first, result, sample()];
	},
	"date method before first call"() {
		Date.parse = () => 23;
		return sample();
	},
	"date method after first call"() {
		const first = sample();
		Date.parse = () => 29;
		return [first, sample()];
	},
	"date namespace before first call"() {
		globalThis.Date = fakeDate();
		return sample();
	},
	"date namespace after first call"() {
		const first = sample();
		globalThis.Date = fakeDate();
		return [first, sample()];
	},
	"object method before first call"() {
		Object.create = () => ({ marker: 31 });
		return sample();
	},
	"object method after first call"() {
		const first = sample();
		Object.create = () => ({ marker: 37 });
		return [first, sample()];
	},
	"object namespace after first call"() {
		const first = sample();
		globalThis.Object = {
			create: () => ({ marker: 41 }),
			entries: () => [["replacement", 43]],
		};
		return [first, sample()];
	},
	"entries method before first call"() {
		Object.entries = () => [["replacement", 71]];
		return sample();
	},
	"entries method after first call"() {
		const first = sample();
		Object.entries = () => [["replacement", 73]];
		return [first, sample()];
	},
	"entries getter rebinding reaches the next call"() {
		const first = sample();
		const entries = entriesMarker({
			get value() {
				Object.entries = () => [["replacement", 79]];
				return 83;
			},
		});
		return [first, entries, sample()];
	},
	"symbol namespace after first call"() {
		const first = sample();
		globalThis.Symbol = { iterator: original.Symbol("replacement") };
		return [first, sample()];
	},
	"symbol getter after first call"() {
		const first = sample();
		let reads = 0;
		original.Object.defineProperty(globalThis, "Symbol", {
			configurable: true,
			get() {
				reads++;
				return original.Symbol;
			},
		});
		return [first, sample(), sample(), reads];
	},
	"deleted date after first call"() {
		const first = sample();
		delete globalThis.Date;
		try {
			sample();
		} catch (error) {
			return [first, error.name];
		}
		throw new Error("deleted Date remained visible");
	},
	"date method getter after first call"() {
		const first = sample();
		let reads = 0;
		original.Object.defineProperty(Date, "parse", {
			configurable: true,
			get() {
				reads++;
				return original.parse;
			},
		});
		return [first, sample(), sample(), reads];
	},
	"date argument rebinding preserves captured callee"() {
		const first = sample();
		function parse(value) {
			return Date.parse(value());
		}
		const value = parse(() => {
			Date.parse = () => 43;
			return text;
		});
		return [first, value, sample()];
	},
	"date coercion rebinding preserves captured callee"() {
		const first = sample();
		const value = Date.parse({
			toString() {
				Date.parse = () => 47;
				return text;
			},
		});
		return [first, value, sample()];
	},
	"discarded literals preserve key coercion and throws"() {
		const events = [];
		const key = {
			toString() {
				events.push("key");
				return "field";
			},
		};
		({ [key]: events.push("value") });
		try {
			({
				[{
					toString() {
						events.push("throw");
						throw new Error("key failure");
					},
				}]: events.push("unreachable"),
			});
		} catch (error) {
			events.push(error.message);
		}
		return events;
	},
};

if (process.env.MUTABLE_SITE_CASE === "list") {
	console.log(JSON.stringify(original.Object.keys(cases)));
} else {
	console.log(JSON.stringify(cases[process.env.MUTABLE_SITE_CASE]()));
}
