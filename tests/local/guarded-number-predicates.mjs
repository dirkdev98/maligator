function check(condition, label) {
	if (!condition) throw new Error(label);
}
function nan(value, extra = () => {}) {
	return Number.isNaN(value, extra());
}
function finite(value, extra = () => {}) {
	return Number.isFinite(value, extra());
}
function integer(value, extra = () => {}) {
	return Number.isInteger(value, extra());
}
function safeInteger(value, extra = () => {}) {
	return Number.isSafeInteger(value, extra());
}
function numericNaN(value, extra = () => {}) {
	return Number.isNaN(+value, extra());
}
function numericFinite(value, extra = () => {}) {
	return Number.isFinite(+value, extra());
}
function numericInteger(value, extra = () => {}) {
	return Number.isInteger(+value, extra());
}
function numericSafeInteger(value, extra = () => {}) {
	return Number.isSafeInteger(+value, extra());
}
function emptyNaN() {
	return Number.isNaN();
}
function emptyFinite() {
	return Number.isFinite();
}
function emptyInteger() {
	return Number.isInteger();
}
function emptySafeInteger() {
	return Number.isSafeInteger();
}

const numberDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Number");
const originalNumber = Number;
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const values = [
	NaN,
	0,
	-0,
	0.5,
	Infinity,
	-Infinity,
	Number.MAX_VALUE,
	Number.MIN_VALUE,
	Number.MAX_SAFE_INTEGER,
	Number.MAX_SAFE_INTEGER + 1,
	-Number.MAX_SAFE_INTEGER,
	-Number.MAX_SAFE_INTEGER - 1,
	1n,
	"1",
	null,
	undefined,
	true,
	Symbol(),
	{},
	new Number(1),
	revoked.proxy,
];
let coercions = 0;
const poison = {
	[Symbol.toPrimitive]() {
		coercions++;
		throw new Error("coerced");
	},
	valueOf() {
		coercions++;
		throw new Error("valueOf");
	},
};

for (const [key, predicate, numeric, empty] of [
	["isNaN", nan, numericNaN, emptyNaN],
	["isFinite", finite, numericFinite, emptyFinite],
	["isInteger", integer, numericInteger, emptyInteger],
	["isSafeInteger", safeInteger, numericSafeInteger, emptySafeInteger],
]) {
	const descriptor = Object.getOwnPropertyDescriptor(originalNumber, key);
	const original = descriptor.value;
	for (const value of values) {
		check(
			predicate(value) === Reflect.apply(original, null, [value]),
			key + " argument boundary",
		);
		if (typeof value === "number")
			check(
				numeric(value) === Reflect.apply(original, null, [value]),
				key + " numeric boundary",
			);
	}
	check(predicate(poison) === false && coercions === 0, key + " never coerces arguments");
	check(empty() === false, key + " omitted argument");
	const expected = Reflect.apply(original, null, [1.25]);
	const marker = {};
	let events = [];
	try {
		Object.defineProperty(originalNumber, key, {
			configurable: true,
			get() {
				check(this === originalNumber, key + " getter receiver");
				events.push("get");
				return original;
			},
		});
		check(
			predicate(1.25, () => {
				events.push("extra");
				Object.defineProperty(originalNumber, key, {
					...descriptor,
					value() {
						return marker;
					},
				});
			}) === expected,
			key + " uses captured callee after mutation",
		);
		check(events.join() === "get,extra", key + " getter before argument effects");
		for (const result of [marker, null, 0, 1n, Symbol(), undefined, "changed"]) {
			originalNumber[key] = () => result;
			check(
				predicate(1.25) === result && numeric(1.25) === result && empty() === result,
				key + " arbitrary replacement result",
			);
		}
		originalNumber[key] = function () {
			return this === originalNumber ? arguments.length : -1;
		};
		check(
			predicate(1.25) === 2 && numeric(1.25) === 2 && empty() === 0,
			key + " fallback preserves receiver and omitted versus extra arguments",
		);
		Object.defineProperty(originalNumber, key, descriptor);
		events = [];
		check(
			numeric(
				{
					valueOf() {
						events.push("coerce");
						originalNumber[key] = () => marker;
						return 1.25;
					},
				},
				() => events.push("extra"),
			) === expected,
			key + " captures callee before explicit conversion",
		);
		check(events.join() === "coerce,extra", key + " explicit conversion order");
		originalNumber[key] = original.bind(null);
		check(predicate(1.25) === expected, key + " bound fallback");
		events = [];
		originalNumber[key] = new Proxy(original, {
			apply(target, receiver, args) {
				check(receiver === originalNumber && args.length === 2, key + " proxy ABI");
				events.push("proxy");
				return Reflect.apply(target, receiver, args);
			},
		});
		check(
			predicate(1.25, () => events.push("extra")) === expected,
			key + " proxy fallback",
		);
		check(events.join() === "extra,proxy", key + " proxy order");
		originalNumber[key] = null;
		events = [];
		let caught;
		try {
			predicate(1.25, () => events.push("extra"));
		} catch (error) {
			caught = error;
		}
		check(
			caught instanceof TypeError && events.join() === "extra",
			key + " noncallable after arguments",
		);
		try {
			predicate(1.25, () => {
				throw marker;
			});
		} catch (error) {
			caught = error;
		}
		check(caught === marker, key + " argument exception wins");
		Object.defineProperty(originalNumber, key, {
			configurable: true,
			get() {
				throw marker;
			},
		});
		events = [];
		try {
			numeric(
				{
					valueOf() {
						events.push("coerce");
						return 0;
					},
				},
				() => events.push("extra"),
			);
		} catch (error) {
			caught = error;
		}
		check(caught === marker && events.length === 0, key + " getter exception wins");
		Object.defineProperty(originalNumber, key, descriptor);
		const namespace = {
			[key](value) {
				check(this === namespace && value === 1.25, key + " replacement namespace ABI");
				return marker;
			},
		};
		globalThis.Number = namespace;
		check(predicate(1.25) === marker, key + " global replacement");
		Object.defineProperty(globalThis, "Number", numberDescriptor);
		if (typeof $262 !== "undefined") {
			const other = $262.createRealm().global;
			originalNumber[key] = other.Number[key];
			for (const value of values)
				check(
					predicate(value) === Reflect.apply(original, null, [value]),
					key + " foreign predicate",
				);
			check(
				numeric(1.25) === expected && empty() === false,
				key + " foreign numeric and omitted arguments",
			);
			check(
				predicate(poison) === false && coercions === 0,
				key + " foreign predicate does not coerce",
			);
		}
	} finally {
		Object.defineProperty(globalThis, "Number", numberDescriptor);
		Object.defineProperty(originalNumber, key, descriptor);
	}
}
function sliceNumber(value) {
	return Number(value.slice(1));
}
function splitNumber(value) {
	return Number(value.split(";")[1].slice(1));
}
function captureNumber(value) {
	const match = /(\d+)/.exec(value);
	return match === null ? -1 : Number(match[1]);
}
function matchNumbers(value) {
	let total = 0;
	for (const match of value.matchAll(/(\d+)/g)) total += Number(match[1]);
	return total;
}
const savedGlobal = globalThis;
const define = Object.defineProperty;
const descriptor = Object.getOwnPropertyDescriptor(savedGlobal, "Number");
const NativeNumber = Number;
try {
	const inputs = [];
	function Replacement(value) {
		inputs.push(value);
		return 37;
	}
	Number = Replacement;
	check(sliceNumber("x12") === 37, "slice consumer observes global constructor");
	check(splitNumber("a;x13") === 37, "split consumer observes global constructor");
	check(captureNumber("x14") === 37, "capture consumer observes global constructor");
	check(matchNumbers("15 16") === 74, "match iterator observes global constructor");
	check(inputs.join(",") === "12,13,14,15,16", "replacement receives original strings");
	check(new Number(9) instanceof Replacement, "construction observes global constructor");
	Number = 4;
	check(Number === 4 && savedGlobal.Number === 4, "direct global assignment");
	check(Number++ === 4 && Number === 5, "postfix global update");
	check(++Number === 6 && savedGlobal.Number === 6, "prefix global update");
	Number += 3;
	check(Number === 9, "compound global assignment");
	Number &&= 10;
	check(Number === 10, "logical global assignment");
	[Number] = [12];
	check(Number === 12, "destructured global assignment");
	let events = [];
	define(savedGlobal, "Number", {
		configurable: true,
		get() {
			events.push("get");
			return NativeNumber;
		},
	});
	check(nan(0, () => events.push("argument")) === false, "global getter predicate");
	check(events.join(",") === "get,argument", "global getter precedes arguments");
	delete savedGlobal.Number;
	check(typeof Number === "undefined", "typeof deleted intrinsic binding");
	let caught;
	try {
		nan(0);
	} catch (error) {
		caught = error;
	}
	check(caught instanceof ReferenceError, "deleted intrinsic binding read throws");
} finally {
	define(savedGlobal, "Number", descriptor);
}
const globalThisDescriptor = Object.getOwnPropertyDescriptor(savedGlobal, "globalThis");
try {
	globalThis = { marker: 73 };
	check(globalThis.marker === 73, "globalThis binding replacement");
} finally {
	define(savedGlobal, "globalThis", globalThisDescriptor);
}
console.log("number predicate guards passed");
