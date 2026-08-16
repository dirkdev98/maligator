const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function throwsTypeError(callback) {
	try {
		callback();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

check("global object stays extensible", Object.isExtensible(globalThis));
globalThis.applicationValue = 1;
check("ordinary globals stay mutable", globalThis.applicationValue === 1);
delete globalThis.applicationValue;

function lockedCodeUnit(value, position) {
	return value.charCodeAt(position);
}
let lockedCodeUnitChecksum = 0;
for (let index = 0; index < 1000; index++) {
	lockedCodeUnitChecksum += lockedCodeUnit("Maligator", index & 7);
}
check("locked charCodeAt static identity", lockedCodeUnitChecksum === 101750);
let positionCoercions = 0;
check(
	"locked charCodeAt coercion fallback",
	lockedCodeUnit("ABC", {
		valueOf() {
			positionCoercions++;
			return 2;
		},
	}) === 67 && positionCoercions === 1,
);
check(
	"locked charCodeAt own-method fallback",
	lockedCodeUnit(
		{
			marker: 40,
			charCodeAt(value) {
				return this.marker + value;
			},
		},
		2,
	) === 42,
);

function lockedSplitProjection(value) {
	const fields = value.split("::");
	return fields[0].length * 100 + Number(fields[1].slice(1)) + fields.length;
}
check(
	"locked split projection static identity",
	lockedSplitProjection("ab::x42::") === 245,
);
let splitGetterCalls = 0;
let splitMethodCalls = 0;
let sliceGetterCalls = 0;
let sliceMethodCalls = 0;
check(
	"locked split projection own-method fallback",
	lockedSplitProjection({
		get split() {
			splitGetterCalls++;
			return function (separator) {
				splitMethodCalls++;
				return separator === "::"
					? [
							"ab",
							{
								get slice() {
									sliceGetterCalls++;
									return function (start) {
										sliceMethodCalls++;
										return start === 1 ? "42" : "0";
									};
								},
							},
							"",
						]
					: [];
			};
		},
	}) === 245 &&
		splitGetterCalls === 1 &&
		splitMethodCalls === 1 &&
		sliceGetterCalls === 1 &&
		sliceMethodCalls === 1,
);

function lockedSplitCursor(value, separator) {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		total += parts[index].trim().length;
	}
	return total;
}
check("locked split cursor static identity", lockedSplitCursor(" a |b| c ", "|") === 3);
let splitCoercions = 0;
check(
	"locked split cursor separator fallback",
	lockedSplitCursor("ignored", {
		[Symbol.split](subject) {
			splitCoercions++;
			return subject === "ignored" ? [" a ", "b"] : [];
		},
	}) === 2 && splitCoercions === 1,
);

function lockedNumericMath() {
	const negativeFraction = -0.4;
	const positive = 1.25;
	const negativeZero = -0;
	return [
		Math.round(negativeFraction),
		Math.floor(positive),
		Math.max(positive, negativeZero),
		Math.min(0, negativeZero),
	];
}
const lockedMathResults = lockedNumericMath();
check(
	"locked Math native-number semantics",
	Object.is(lockedMathResults[0], -0) &&
		lockedMathResults[1] === 1 &&
		lockedMathResults[2] === 1.25 &&
		Object.is(lockedMathResults[3], -0),
);

function lockedLiteralExec(value) {
	const match = /([a-z]+)=([0-9]+)/.exec(value);
	if (match === null) return -1;
	return match[1].length * 100 + Number(match[2]);
}
check("locked fresh RegExp exec projection", lockedLiteralExec("age=42") === 342);
let literalExecCoercions = 0;
check(
	"locked fresh RegExp exec preserves input coercion",
	lockedLiteralExec({
		toString() {
			literalExecCoercions++;
			return "id=7";
		},
	}) === 207 && literalExecCoercions === 1,
);
const literalExecError = new Error("literal exec coercion");
let literalExecCaught = false;
try {
	lockedLiteralExec({
		toString() {
			throw literalExecError;
		},
	});
} catch (error) {
	literalExecCaught = error === literalExecError;
}
check("locked fresh RegExp exec preserves coercion exceptions", literalExecCaught);

function lockedFreshArrayReduce() {
	return [1, 2, 3, 4].reduce((sum, value) => sum + value, 0);
}
check("locked fresh Array reduce loop", lockedFreshArrayReduce() === 10);

function lockedFreshArrayForEachMutation() {
	let total = 0;
	let observedLength = 0;
	[1, 2, 3].forEach((value, index, array) => {
		total += value;
		if (index === 0) array.push(4);
		observedLength = array.length;
	});
	return total * 10 + observedLength;
}
check(
	"locked fresh Array forEach keeps length snapshot and callback receiver",
	lockedFreshArrayForEachMutation() === 64,
);

for (const [name, value] of [
	["Object", Object],
	["String", String],
	["Math", Math],
	["JSON", JSON],
	["Reflect", Reflect],
	["Array.prototype", Array.prototype],
	["String.prototype", String.prototype],
	["String.prototype.split", String.prototype.split],
]) {
	check(name + " is physically frozen", Object.isFrozen(value));
}

const splitDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "split");
check(
	"protected descriptors are physical",
	splitDescriptor.writable === false && splitDescriptor.configurable === false,
);
check(
	"global aliases are physical",
	Object.getOwnPropertyDescriptor(globalThis, "Math").writable === false &&
		Object.getOwnPropertyDescriptor(globalThis, "Math").configurable === false,
);

check(
	"strict method assignment throws",
	throwsTypeError(() => {
		String.prototype.split = function () {};
	}),
);
check(
	"sloppy method assignment throws",
	throwsTypeError(() => {
		Function("Math.extra = 1")();
	}),
);
check(
	"new primordial property throws",
	throwsTypeError(() => {
		Math.extra = 1;
	}),
);
let mutationMessage = "";
try {
	Math.namedFailure = 1;
} catch (error) {
	mutationMessage = error.message;
}
check(
	"runtime mutation error names property",
	mutationMessage.includes("'namedFailure'"),
);
check(
	"computed alias assignment throws",
	throwsTypeError(() => {
		const target = String.prototype;
		const key = "sp" + "lit";
		target[key] = function () {};
	}),
);
check(
	"array prototype index throws",
	throwsTypeError(() => {
		Array.prototype[0] = 1;
	}),
);
check(
	"array prototype length throws",
	throwsTypeError(() => {
		Array.prototype.length = 1;
	}),
);
check(
	"global alias assignment throws",
	throwsTypeError(() => {
		globalThis.Math = 1;
	}),
);
check(
	"bare global alias assignment throws",
	throwsTypeError(() => {
		Function("Math = 1")();
	}),
);
check(
	"global alias delete throws",
	throwsTypeError(() => {
		delete globalThis.Math;
	}),
);
check(
	"bare global alias delete throws",
	throwsTypeError(() => {
		Function("return delete Math")();
	}),
);
check(
	"global var initializer throws",
	throwsTypeError(() => {
		(0, eval)("var Math = 1");
	}),
);
check(
	"global var redeclaration is an idempotent no-op",
	(0, eval)("var Math; Math") === Math,
);
check(
	"global function declaration throws",
	throwsTypeError(() => {
		(0, eval)("function Object() {}");
	}),
);
check(
	"existing property delete throws",
	throwsTypeError(() => {
		delete String.prototype.split;
	}),
);
check("absent property delete is a no-op", delete String.prototype.notPresent);

check(
	"changed defineProperty throws",
	throwsTypeError(() => {
		Object.defineProperty(String.prototype, "split", { value: function () {} });
	}),
);
check(
	"changed Reflect.defineProperty throws",
	throwsTypeError(() => {
		Reflect.defineProperty(String.prototype, "split", { value: function () {} });
	}),
);
check(
	"changed Object.defineProperties throws",
	throwsTypeError(() => {
		Object.defineProperties(String.prototype, {
			split: { value: function () {} },
		});
	}),
);
check(
	"identical defineProperty succeeds",
	Object.defineProperty(String.prototype, "split", splitDescriptor) === String.prototype,
);
check(
	"identical Reflect.defineProperty succeeds",
	Reflect.defineProperty(String.prototype, "split", splitDescriptor),
);
const mathGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Math");
check(
	"identical global binding define succeeds",
	Reflect.defineProperty(globalThis, "Math", mathGlobalDescriptor),
);
check(
	"changed global binding define throws",
	throwsTypeError(() => {
		Reflect.defineProperty(globalThis, "Math", { value: 1 });
	}),
);

check("Object.freeze is idempotent", Object.freeze(Math) === Math);
check("Object.seal is idempotent", Object.seal(Math) === Math);
check("Object.preventExtensions is idempotent", Object.preventExtensions(Math) === Math);
check("Reflect.preventExtensions is idempotent", Reflect.preventExtensions(Math));
check(
	"same Object.setPrototypeOf succeeds",
	Object.setPrototypeOf(Math, Object.getPrototypeOf(Math)) === Math,
);
check(
	"same Reflect.setPrototypeOf succeeds",
	Reflect.setPrototypeOf(Math, Object.getPrototypeOf(Math)),
);
check(
	"different Object.setPrototypeOf throws",
	throwsTypeError(() => {
		Object.setPrototypeOf(Math, null);
	}),
);
check(
	"different Reflect.setPrototypeOf throws",
	throwsTypeError(() => {
		Reflect.setPrototypeOf(Math, null);
	}),
);
check(
	"legacy prototype mutation throws",
	throwsTypeError(() => {
		Math.__proto__ = null;
	}),
);

check(
	"Object.assign mutation throws",
	throwsTypeError(() => {
		Object.assign(Math, { extra: 1 });
	}),
);
check(
	"Reflect.set mutation throws",
	throwsTypeError(() => {
		Reflect.set(Math, "extra", 1);
	}),
);
const receiver = {};
check(
	"Reflect.set may write a distinct ordinary receiver",
	Reflect.set(Math, "receiverOnly", 1, receiver) && receiver.receiverOnly === 1,
);

const forwardingProxy = new Proxy(String.prototype, {});
check(
	"forwarding proxy mutation throws",
	throwsTypeError(() => {
		forwardingProxy.split = function () {};
	}),
);
check(
	"forwarding proxy definition throws",
	throwsTypeError(() => {
		Reflect.defineProperty(forwardingProxy, "split", { value: function () {} });
	}),
);
check(
	"forwarding proxy deletion throws",
	throwsTypeError(() => {
		Reflect.deleteProperty(forwardingProxy, "split");
	}),
);
const inertProxy = new Proxy(String.prototype, {
	set() {
		return false;
	},
});
check(
	"non-mutating proxy trap stays ordinary",
	Reflect.set(inertProxy, "split", 1) === false,
);
const acceptingProxy = new Proxy(String.prototype, {
	set() {
		return true;
	},
});
check(
	"successful non-mutating proxy trap stays ordinary",
	Reflect.set(acceptingProxy, "notInstalled", 1) && !("notInstalled" in String.prototype),
);

check(
	"eval inherits locked policy",
	eval(`
	try {
		Math.extra = 1;
		false;
	} catch (error) {
		error instanceof TypeError;
	}
`),
);
check(
	"Function inherits locked policy",
	Function(`
	try {
		String.prototype.split = 1;
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
`)(),
);

const realm = new ShadowRealm();
check(
	"new Realm initializes locked primordials",
	realm.evaluate(`
	Object.isFrozen(Math) && (() => {
		try {
			Math.extra = 1;
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	})()
`),
);

const ordinary = { value: 1 };
ordinary.value = 2;
ordinary.extra = 3;
delete ordinary.value;
Object.setPrototypeOf(ordinary, null);
check(
	"ordinary objects stay mutable",
	ordinary.value === undefined &&
		ordinary.extra === 3 &&
		Object.getPrototypeOf(ordinary) === null,
);
const withProto = {};
withProto.__proto__ = null;
check(
	"inherited primordial setters still work for user objects",
	Object.getPrototypeOf(withProto) === null,
);

console.extension = 1;
check("console stays outside the language primordial graph", console.extension === 1);
delete console.extension;

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL " + name);
}
console.log("RESULT " + passed + "/" + results.length);
