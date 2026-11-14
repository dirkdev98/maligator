import vm from "node:vm";

function read(...values) {
	return values[0] + values[1] + values[2];
}
function callSite(a, b, c) {
	return read.call(null, a, b, c);
}
function applySite(...values) {
	return read.apply(null, values);
}
function suffix(prefix, ...values) {
	return [prefix, values.length, values[0], values[1]];
}
function choose(which, ...values) {
	return which ? values[0] : values[3];
}
function held(collect, ...values) {
	collect();
	return values[0].value + values[1].value;
}
function effectful(hook, ...values) {
	const first = values[0];
	hook();
	return first + values[2];
}

const cases = {
	arities() {
		return [
			read(),
			read(1),
			read(1, 2),
			read(1, 2, 3),
			read(1, 2, 3, 4),
			suffix(7),
			suffix(7, 1, 2),
			choose(true, 5),
			choose(false, 1, 2, 3, 4),
		];
	},
	"getter-before"() {
		let calls = 0;
		Object.defineProperty(Array.prototype, "2", {
			configurable: true,
			get() {
				calls++;
				return this[0] + 10;
			},
		});
		return [read(1, 2), read(1, 2, 3), calls];
	},
	"getter-after"() {
		const first = read(1, 2, 3);
		let calls = 0;
		Object.defineProperty(Array.prototype, "2", {
			configurable: true,
			get() {
				calls++;
				return this[0] + 10;
			},
		});
		return [first, read(1, 2), read(1, 2, 3), calls];
	},
	"coercion-before-later-read"() {
		const first = {
			valueOf() {
				Object.defineProperty(Array.prototype, "2", {
					configurable: true,
					get() {
						return this[0] === first ? 19 : 29;
					},
				});
				return 5;
			},
		};
		return [read(first, 2), read(first, 2, 7)];
	},
	"effect-before-later-read"() {
		return effectful(
			() =>
				Object.defineProperty(Array.prototype, "2", {
					configurable: true,
					get() {
						return 41;
					},
				}),
			1,
		);
	},
	"getter-mutates-rest"() {
		Object.defineProperty(Array.prototype, "1", {
			configurable: true,
			get() {
				delete Array.prototype[1];
				Object.defineProperty(this, "2", { value: 17 });
				return 5;
			},
		});
		return read(7);
	},
	"foreign-getter"() {
		const other = vm.runInNewContext("globalThis");
		const getter = other.Function("throw new TypeError('foreign')");
		Object.defineProperty(Array.prototype, "2", { configurable: true, get: getter });
		try {
			return read(1, 2);
		} catch (error) {
			return [error instanceof other.TypeError, error instanceof TypeError];
		}
	},
	"proxy-prototype"() {
		const effects = [];
		const prototype = new Proxy(Object.prototype, {
			get(target, key, receiver) {
				effects.push(String(key));
				return key === "2" ? 31 : Reflect.get(target, key, receiver);
			},
		});
		Object.setPrototypeOf(Array.prototype, prototype);
		return [read(1, 2), read(1, 2, 3), effects];
	},
	gc() {
		return held(
			() => {
				if (globalThis.gc) globalThis.gc();
			},
			{ value: 11 },
			{ value: 17 },
		);
	},
	throw() {
		try {
			return read(1n, 2, 3);
		} catch (error) {
			return error.name;
		}
	},
};
for (const method of ["call", "apply"]) {
	for (const timing of ["before", "after"]) {
		cases[`${method}-${timing}`] = () => {
			const site = method === "call" ? callSite : applySite;
			const output = [];
			if (timing === "after") output.push(site(1, 2, 3));
			const original = Function.prototype[method];
			Function.prototype[method] = function (...args) {
				if (this === read) return ["patched", args[0] === null, args.length];
				return Reflect.apply(original, this, args);
			};
			try {
				output.push(site(1, 2, 3));
			} finally {
				Function.prototype[method] = original;
			}
			return output;
		};
	}
}
const scenario = process.env.REST_READ_CASE ?? "arities";
if (scenario === "list") console.log(Object.keys(cases).join("\n"));
else console.log(JSON.stringify(cases[scenario]()));
