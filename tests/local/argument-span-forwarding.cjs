const scenario = process.env.ARGUMENT_SPAN_CASE;
const cases = {
	forwarding() {
		function add(a, b, c) {
			return this.base + a + b + c;
		}
		const receiver = { base: 7 };
		function spread(target, ...values) {
			return target(...values);
		}
		function apply(target, ...values) {
			return target.apply(receiver, values);
		}
		function known(...values) {
			return add.apply(receiver, values);
		}
		let sum = 0;
		for (let index = 0; index < 30; index++) {
			sum += spread(Math.max, index, 2, 3);
			sum += apply(add, index, 2, 3) + known(index, 2, 3);
		}
		return sum;
	},
	holes_and_getters() {
		const lines = [];
		function forward(target, values) {
			return target(...values);
		}
		function apply(target, values) {
			return target.apply(null, values);
		}
		const sparse = [1, , 3];
		lines.push(forward(show, sparse), apply(show, sparse));
		const inherited = Object.create(Array.prototype);
		Object.defineProperty(inherited, 1, {
			get() {
				return 12;
			},
		});
		Object.setPrototypeOf(sparse, inherited);
		lines.push(forward(show, sparse), apply(show, sparse));
		function shrinking() {
			const values = [0, 2, 3];
			Object.defineProperty(values, 0, {
				get() {
					values.length = 1;
					return 9;
				},
			});
			return values;
		}
		lines.push(forward(show, shrinking()), apply(show, shrinking()));
		let trace = "";
		const list = {
			get length() {
				trace += "length;";
				return 2;
			},
			get 0() {
				trace += "zero;";
				return 4;
			},
			get 1() {
				trace += "one;";
				return 5;
			},
		};
		lines.push(apply(show, list), trace);
		return lines.join("/");
	},
	iterator_replacement() {
		function forward(...values) {
			return show(...values);
		}
		const original = Array.prototype[Symbol.iterator];
		const before = forward(1, 2);
		let calls = 0;
		Array.prototype[Symbol.iterator] = function () {
			calls++;
			return original.call([this[0] + 10, this.length]);
		};
		let changed;
		try {
			changed = `${forward(1, 2)}/${forward()}`;
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
		return `${before}/${changed}/${forward(3, 4)}/${calls}`;
	},
	iterator_next_replacement() {
		function forward(...values) {
			return show(...values);
		}
		const before = forward(1, 2);
		const prototype = Object.getPrototypeOf([][Symbol.iterator]());
		const original = prototype.next;
		let calls = 0;
		prototype.next = function () {
			const result = original.call(this);
			calls++;
			if (!result.done) result.value += 20;
			return result;
		};
		let changed;
		try {
			changed = forward(1, 2);
		} finally {
			prototype.next = original;
		}
		return `${before}/${changed}/${forward(3, 4)}/${calls}`;
	},
	apply_replacement() {
		function target(a, b) {
			return a + b;
		}
		function forward(...values) {
			return target.apply(null, values);
		}
		const before = forward(1, 2);
		const original = Function.prototype.apply;
		let kept;
		Function.prototype.apply = function (_receiver, values) {
			kept = values;
			values[0] += 10;
			return original.call(this, null, values);
		};
		let changed;
		try {
			changed = forward(1, 2);
		} finally {
			Function.prototype.apply = original;
		}
		return `${before}/${changed}/${forward(3, 4)}/${Array.isArray(kept)}/${kept[0]}`;
	},
	materialized_identity() {
		let kept;
		let count = 0;
		function target(a, b) {
			return a + b;
		}
		const original = Function.prototype.apply;
		Object.defineProperty(target, "apply", {
			get() {
				if (count++ === 0)
					return function (_receiver, values) {
						kept = values;
						values[0] = 40;
						return 1;
					};
				return original;
			},
		});
		function twice(...values) {
			return target.apply(null, values) + target.apply(null, values);
		}
		return `${twice(1, 2)}/${kept[0]}/${count}`;
	},
	proxies() {
		let trace = "";
		const values = new Proxy([1, 2], {
			get(target, key, receiver) {
				trace += `${String(key)};`;
				return Reflect.get(target, key, receiver);
			},
		});
		function spread(target, ...args) {
			return target(...args);
		}
		function apply(target, ...args) {
			return target.apply(null, args);
		}
		const target = new Proxy(show, {
			apply(fn, receiver, args) {
				return `proxy:${Reflect.apply(fn, receiver, args)}`;
			},
		});
		const first = show(...values);
		const spreadTrace = trace;
		trace = "";
		const second = show.apply(null, values);
		const revoked = Proxy.revocable(show, {});
		revoked.revoke();
		return `${first}/${spreadTrace}/${second}/${trace}/${spread(target, 3, 4)}/${apply(target, 5, 6)}/${errorName(() => spread(revoked.proxy, 1))}/${errorName(() => apply(revoked.proxy, 1))}`;
	},
	sloppy_arguments() {
		const mapped = (0, eval)(`(function (first, second) {
			first = 9;
			arguments[1] = 12;
			return (function (a, b) { return a + ":" + b; }).apply(null, arguments) + ":" + second;
		})`);
		const deleted = (0, eval)(`(function (first) {
			delete arguments[0];
			first = 20;
			return (function (...values) { return values.length + ":" + values[0]; })(...arguments) + ":" + first;
		})`);
		const getter = (0, eval)(`(function (first) {
			Object.defineProperty(arguments, 0, { get() { return first + 30; } });
			return Function.prototype.apply.call(function (value) { return value; }, null, arguments);
		})`);
		return `${mapped(1, 2)}/${deleted(3)}/${getter(4)}`;
	},
	unmapped_materialization() {
		function target(first, second) {
			return first.value + second.value;
		}
		function forward() {
			"use strict";
			return target.apply(null, arguments);
		}
		let result = "";
		for (let index = 0; index < 3; index++)
			result += `${forward({ value: index }, { value: 7 })};`;
		target.apply = function (_receiver, values) {
			(globalThis.__mal_collect_garbage || globalThis.gc || (() => {}))();
			const length = Object.getOwnPropertyDescriptor(values, "length");
			return `${Object.prototype.toString.call(values)}:${Array.isArray(values)}:${length.enumerable}:${length.writable}:${length.configurable}:${values[0].value}:${values[1].value}:${errorName(() => values.callee)}`;
		};
		for (let index = 0; index < 3; index++)
			result += `${forward({ value: index }, { value: 9 })};`;
		return result;
	},
	unmapped_arguments() {
		function spread() {
			"use strict";
			return show(...arguments);
		}
		function apply() {
			"use strict";
			return show.apply(null, arguments);
		}
		const before = `${spread(1, 2)}/${apply(3, 4)}`;
		const original = Array.prototype[Symbol.iterator];
		Array.prototype[Symbol.iterator] = function () {
			throw new Error("Array iterator");
		};
		let after;
		try {
			after = `${spread(5, 6)}/${apply(7, 8)}`;
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
		return `${before}/${after}`;
	},
	foreign_apply() {
		const vm = require("node:vm");
		const foreign = vm.runInNewContext(
			"({ apply: Function.prototype.apply, TypeError, Object })",
		);
		function target(a, b) {
			return a + b;
		}
		function forward(fn, ...values) {
			return fn.apply(null, values);
		}
		target.apply = foreign.apply;
		const result = forward(target, 2, 3);
		let provenance;
		try {
			forward({ apply: foreign.apply }, 1);
		} catch (error) {
			provenance = error instanceof foreign.TypeError && !(error instanceof TypeError);
		}
		let local;
		target.apply = function (_receiver, values) {
			local = Object.getPrototypeOf(values) === Array.prototype;
			return values[0];
		};
		return `${result}/${provenance}/${forward(target, 7)}/${local}`;
	},
	argument_limits() {
		function forward(...values) {
			return show(...values);
		}
		function apply(values) {
			return show.apply(null, values);
		}
		const values = Array.from({ length: 1024 }, (_, index) => index & 3);
		let reads = 0;
		const enormous = {
			length: 2147483648,
			get 0() {
				reads++;
				return 1;
			},
		};
		return `${forward(...values).length}/${errorName(() => apply(enormous))}/${reads}`;
	},
};
function show() {
	let result = `${arguments.length}:`;
	for (let index = 0; index < arguments.length; index++) result += `${arguments[index]}|`;
	return result;
}
function errorName(run) {
	try {
		run();
		return "missing";
	} catch (error) {
		return error.name;
	}
}
if (scenario === "list") console.log(Object.keys(cases).join("\n"));
else console.log(cases[scenario]());
