const method = process.env.REENTRY_METHOD ?? "isFinite";
const family = process.env.REENTRY_FAMILY ?? "number";
const scenario = process.env.REENTRY_CASE ?? "values";
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const collect = () => {
	if (typeof gc === "function") gc();
};
const numberProbes = {
	isNaN(value) {
		return Number.isNaN(Number(value));
	},
	isFinite(value) {
		return Number.isFinite(Number(value));
	},
	isInteger(value) {
		return Number.isInteger(Number(value));
	},
	isSafeInteger(value) {
		return Number.isSafeInteger(Number(value));
	},
};
const unaryProbes = {
	isNaN(value) {
		return Number.isNaN(+value);
	},
	isFinite(value) {
		return Number.isFinite(+value);
	},
	isInteger(value) {
		return Number.isInteger(+value);
	},
	isSafeInteger(value) {
		return Number.isSafeInteger(+value);
	},
};
const extraProbes = {
	isNaN(value, extra) {
		return Number.isNaN(+value, +extra);
	},
	isFinite(value, extra) {
		return Number.isFinite(+value, +extra);
	},
	isInteger(value, extra) {
		return Number.isInteger(+value, +extra);
	},
	isSafeInteger(value, extra) {
		return Number.isSafeInteger(+value, +extra);
	},
};
globalThis.reentryProbes = { numberProbes, unaryProbes, extraProbes };
const probe = (family === "number" ? numberProbes : unaryProbes)[method];
const originalNumber = Number;
const descriptor = Object.getOwnPropertyDescriptor(Number, method);
const marker = { label: "coercion throw" };
let coercions = 0;
let outcome;
const value = {
	valueOf() {
		coercions++;
		if (scenario === "delete") delete Number[method];
		else if (scenario === "global") {
			function replacement() {
				return 5;
			}
			replacement[method] = () => "global replacement";
			globalThis.Number = replacement;
		} else if (scenario === "throw") {
			collect();
			throw marker;
		} else if (scenario !== "values" && scenario !== "noncallable")
			Object.defineProperty(Number, method, {
				value: () => "method replacement",
				configurable: true,
				writable: true,
			});
		collect();
		return 42;
	},
};
try {
	if (scenario === "values") {
		outcome = [];
		for (const input of [undefined, null, true, "7", "x", Infinity, NaN, -0, 1n, value]) {
			try {
				outcome.push(probe(input));
			} catch (error) {
				outcome.push(error.name);
			}
		}
		outcome.push(coercions);
	} else if (scenario === "noncallable") {
		Number[method] = 17;
		try {
			probe(value);
			outcome = "missing throw";
		} catch (error) {
			outcome = { error: error.name, coercions };
		}
	} else if (scenario === "accessor") {
		let reads = 0;
		Object.defineProperty(Number, method, {
			configurable: true,
			get() {
				reads++;
				return () => "accessor result";
			},
		});
		outcome = { first: probe(value), next: probe(7), reads, coercions };
	} else if (scenario === "extra") {
		const trace = [];
		const first = {
			valueOf() {
				trace.push("first");
				Number[method] = () => "late";
				collect();
				return 42;
			},
		};
		const extra = {
			valueOf() {
				trace.push("extra");
				collect();
				return 9;
			},
		};
		outcome = { first: extraProbes[method](first, extra), trace };
	} else if (scenario === "throw") {
		try {
			probe(value);
			outcome = "missing throw";
		} catch (error) {
			outcome = { same: error === marker, coercions };
		}
	} else {
		outcome = { first: probe(value) };
		try {
			outcome.next = probe(value);
		} catch (error) {
			outcome.next = error.name;
		}
		outcome.coercions = coercions;
	}
} finally {
	globalThis.Number = originalNumber;
	Object.defineProperty(Number, method, descriptor);
}
console.log(JSON.stringify(outcome));
