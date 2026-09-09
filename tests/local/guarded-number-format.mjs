function check(condition, label) {
	if (!condition) throw new Error(label);
}

function fixed(value, option, extra = () => {}) {
	return value.toFixed(option, extra());
}
function exponential(value, option, extra = () => {}) {
	return value.toExponential(option, extra());
}
function precision(value, option, extra = () => {}) {
	return value.toPrecision(option, extra());
}
function fixedTwo(value) {
	return value.toFixed(2);
}
function exponentialTwo(value) {
	return value.toExponential(2);
}
function precisionTwo(value) {
	return value.toPrecision(2);
}
function outcome(callback) {
	try {
		return callback();
	} catch (error) {
		return error.constructor.name;
	}
}

const values = [
	0,
	-0,
	1.005,
	-1.005,
	1.25,
	12345.6789,
	5e-324,
	1e-308,
	1e21,
	1e100,
	Number.MAX_VALUE,
	NaN,
	Infinity,
	-Infinity,
];
const options = [
	undefined,
	0,
	-0,
	1,
	2,
	20,
	100,
	-1,
	101,
	NaN,
	Infinity,
	2.9,
	"2",
	null,
	true,
	1n,
	Symbol(),
];

for (const [key, format, prepared] of [
	["toFixed", fixed, fixedTwo],
	["toExponential", exponential, exponentialTwo],
	["toPrecision", precision, precisionTwo],
]) {
	const descriptor = Object.getOwnPropertyDescriptor(Number.prototype, key);
	const original = descriptor.value;
	for (const value of values) {
		check(
			prepared(value) === Reflect.apply(original, value, [2]),
			key + " prepared numeric option",
		);
		for (const option of options) {
			const expected = outcome(() => Reflect.apply(original, value, [option]));
			check(outcome(() => format(value, option)) === expected, key + " numeric boundary");
		}
	}
	check(
		format(new Number(1.25), 2) === Reflect.apply(original, 1.25, [2]),
		key + " wrapper fallback",
	);
	const expected = Reflect.apply(original, 1.25, [2]);
	let events = [];
	try {
		Object.defineProperty(Number.prototype, key, {
			configurable: true,
			get() {
				events.push("get:" + typeof this);
				return original;
			},
		});
		check(
			format(1.25, 2, () => {
				events.push("extra");
				Object.defineProperty(Number.prototype, key, {
					configurable: true,
					writable: true,
					value() {
						return "changed";
					},
				});
			}) === expected,
			key + " retains loaded callee",
		);
		check(events.join() === "get:number,extra", key + " getter argument order");
		check(format(1.25, 2) === "changed", key + " replacement fallback");
		check(prepared(1.25) === "changed", key + " prepared replacement fallback");
		for (const result of [undefined, null, false, 123, 1n, Symbol(), {}]) {
			Number.prototype[key] = () => result;
			check(format(1.25, 2) === result, key + " preserves replacement result kind");
			check(
				prepared(1.25) === result,
				key + " preserves prepared replacement result kind",
			);
		}
		Number.prototype[key] = null;
		events = [];
		check(
			outcome(() => format(1.25, 2, () => events.push("extra"))) === "TypeError",
			key + " noncallable replacement",
		);
		check(events.join() === "extra", key + " arguments precede noncallable rejection");
		const argumentError = {};
		let caughtArgumentError;
		try {
			format(1.25, 2, () => {
				throw argumentError;
			});
		} catch (error) {
			caughtArgumentError = error;
		}
		check(
			caughtArgumentError === argumentError,
			key + " argument error precedes noncallable rejection",
		);
		Object.defineProperty(Number.prototype, key, descriptor);
		events = [];
		const option = {
			[Symbol.toPrimitive](hint) {
				events.push(hint);
				Number.prototype[key] = () => "changed again";
				return 2;
			},
		};
		check(
			format(1.25, option, () => events.push("extra")) === expected,
			key + " coercion fallback",
		);
		check(events.join() === "extra,number", key + " coerces once after extra argument");
		Object.defineProperty(Number.prototype, key, descriptor);
		events = [];
		check(
			outcome(() => format({ [key]: original }, option)) === "TypeError",
			key + " wrong brand",
		);
		check(events.length === 0, key + " validates brand before option coercion");
		check(
			outcome(() => prepared({ [key]: original })) === "TypeError",
			key + " prepared wrong brand",
		);
		Number.prototype[key] = original.bind(1.25);
		check(format(100, 2) === expected, key + " bound callee fallback");
		Number.prototype[key] = new Proxy(original, {
			apply(target, receiver, args) {
				events.push("proxy");
				return Reflect.apply(target, receiver, args);
			},
		});
		check(
			format(1.25, 2) === expected && events.join() === "proxy",
			key + " proxy fallback",
		);
		Object.defineProperty(Number.prototype, key, {
			configurable: true,
			get() {
				throw new Error("getter");
			},
		});
		events = [];
		check(
			outcome(() => format(1.25, 2, () => events.push("extra"))) === "Error",
			key + " getter throw",
		);
		check(events.length === 0, key + " getter throw precedes argument effects");
		if (typeof $262 !== "undefined") {
			const other = $262.createRealm().global;
			Object.defineProperty(Number.prototype, key, {
				...descriptor,
				value: other.Number.prototype[key],
			});
			check(format(1.25, 2) === expected, key + " foreign callee");
			check(prepared(1.25) === expected, key + " prepared foreign callee");
			let caught;
			try {
				format(1.25, 101);
			} catch (error) {
				caught = error;
			}
			check(
				Object.getPrototypeOf(caught) === other.RangeError.prototype,
				key + " foreign range error",
			);
			try {
				format({ [key]: other.Number.prototype[key] }, 2);
			} catch (error) {
				caught = error;
			}
			check(
				Object.getPrototypeOf(caught) === other.TypeError.prototype,
				key + " foreign brand error",
			);
			const marker = {};
			try {
				format(1.25, {
					valueOf() {
						throw marker;
					},
				});
			} catch (error) {
				caught = error;
			}
			check(caught === marker, key + " preserves coercion exception");
		}
	} finally {
		Object.defineProperty(Number.prototype, key, descriptor);
	}
}
console.log("number formatting guards passed");
