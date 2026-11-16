function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}
function box(value, prototype) {
	Object.defineProperty(prototype, "__withReceiver", {
		configurable: true,
		value: function () {
			"use strict";
			this.marker = (this.marker || 0) + 1;
			return this;
		},
	});
	try {
		let first, second, read, other;
		with (value) {
			first = __withReceiver();
			second = __withReceiver();
			read = () => __withReceiver();
		}
		const escaped = read();
		with (value) {
			other = __withReceiver();
		}
		return [
			typeof first,
			Object.prototype.toString.call(first),
			first.valueOf() === value,
			first === second,
			first === escaped,
			first !== other,
			first.marker,
			other.marker,
		];
	} finally {
		delete prototype.__withReceiver;
	}
}
function nil(value) {
	let entered = false;
	const outcome = observe(() => {
		with (value) {
			entered = true;
		}
	});
	return [entered, outcome];
}
function abrupt(kind, operation) {
	const thrown = {};
	const outer = { target: 1 };
	const data = { target: 2 };
	let inner = data;
	if (kind === "has") {
		inner = new Proxy(data, {
			has(object, key) {
				if (key === "target") throw thrown;
				return Reflect.has(object, key);
			},
		});
	} else if (kind === "unscopables") {
		Object.defineProperty(data, Symbol.unscopables, {
			get() {
				throw thrown;
			},
		});
	} else {
		data[Symbol.unscopables] = {
			get target() {
				throw thrown;
			},
		};
	}
	let sameThrow = false;
	try {
		with (outer) {
			with (inner) {
				if (operation === "write") ({ target } = { target: 9 });
				else if (operation === "update") target++;
				else if (operation === "loop") {
					for (target of [9]) {
					}
				} else if (operation === "call") target();
				else void target;
			}
		}
	} catch (error) {
		sameThrow = error === thrown;
	}
	return [sameThrow, data.target, outer.target];
}
const output = {};
for (const [name, value, prototype] of [
	["string", "abc", String.prototype],
	["number", 42, Number.prototype],
	["boolean", true, Boolean.prototype],
	["symbol", Symbol("fixture"), Symbol.prototype],
	["bigint", 42n, BigInt.prototype],
	["object", {}, Object.prototype],
])
	output[name] = observe(() => box(value, prototype));
output.nil = [nil(null), nil(undefined)];
output.stringProperties = observe(() => {
	with ("abc") return [length, charAt(1), slice(1)];
});
for (const kind of ["has", "unscopables", "blockedName"])
	for (const operation of ["write", "update", "loop", "call", "read"])
		output[kind + "-" + operation] = abrupt(kind, operation);
console.log(JSON.stringify(output));
