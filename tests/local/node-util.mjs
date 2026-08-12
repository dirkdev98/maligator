import util, {
	deprecate,
	format,
	formatWithOptions,
	inherits,
	inspect,
	isArray,
	isBoolean,
	isBuffer,
	isFunction,
	isNull,
	isNullOrUndefined,
	isNumber,
	isObject,
	isString,
	isSymbol,
	isUndefined,
	promisify,
} from "node:util";

const { types } = util;

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(util.inspect === inspect, "default/named inspect identity");
check(util.inherits === inherits, "default/named inherits identity");
check(util.promisify === promisify, "default/named promisify identity");
function callbackValue(value, callback) {
	callback(null, value * 2);
}
check((await promisify(callbackValue)(21)) === 42, "promisify fulfillment");
let rejection = "";
try {
	await promisify((callback) => callback(new Error("rejected")))();
} catch (error) {
	rejection = error.message;
}
check(rejection === "rejected", "promisify rejection");
check(format("hello %s %d %%", "world", 4) === "hello world 4 %", "format tokens");
check(format("extra", { value: 1 }) === "extra { value: 1 }", "format extras");
check(
	formatWithOptions({ depth: 0 }, "%O", { nested: { value: 1 } }) ===
		"{ nested: [Object] }",
	"format options depth",
);
check(inspect([1, "two"]) === "[ 1, 'two' ]", "array inspection");
check(inspect("quoted") === "'quoted'" && inspect({}) === "{}", "scalar inspection");
const legacyCases = [
	["isArray", isArray, [], true],
	["isBoolean", isBoolean, false, true],
	["isBuffer", isBuffer, Buffer.from("x"), true],
	["isFunction", isFunction, () => 1, true],
	["isNull", isNull, null, true],
	["isNullOrUndefined", isNullOrUndefined, undefined, true],
	["isNumber", isNumber, 1.5, true],
	["isObject", isObject, {}, true],
	["isString", isString, "node", true],
	["isSymbol", isSymbol, Symbol("node"), true],
	["isUndefined", isUndefined, undefined, true],
];
for (const [name, predicate, value, expected] of legacyCases) {
	check(predicate(value) === expected, `${name} positive`);
	check(predicate.name === name && predicate.length === 1, `${name} metadata`);
	check(util[name] === predicate, `${name} default/named identity`);
}
check(!isBuffer(new Uint8Array(1)), "isBuffer rejects plain Uint8Array");
check(!isObject(null) && !isObject(() => 1), "isObject follows legacy Node semantics");

const typeCases = [
	["isAnyArrayBuffer", new ArrayBuffer(1), true],
	["isArrayBuffer", new ArrayBuffer(1), true],
	["isSharedArrayBuffer", new SharedArrayBuffer(1), true],
	["isDataView", new DataView(new ArrayBuffer(2)), true],
	["isDate", new Date(), true],
	["isMap", new Map(), true],
	["isSet", new Set(), true],
	["isWeakMap", new WeakMap(), true],
	["isWeakSet", new WeakSet(), true],
	["isRegExp", /node/, true],
	["isTypedArray", new Uint8Array(1), true],
	["isBoxedPrimitive", Object(1), true],
	[
		"isGeneratorObject",
		(function* () {
			yield 1;
		})(),
		true,
	],
	["isProxy", new Proxy({}, {}), true],
	["isMapIterator", new Map().entries(), true],
	["isSetIterator", new Set().values(), true],
	["isInt8Array", new Int8Array(1), true],
	["isUint8Array", new Uint8Array(1), true],
	["isUint8ClampedArray", new Uint8ClampedArray(1), true],
	["isInt16Array", new Int16Array(1), true],
	["isUint16Array", new Uint16Array(1), true],
	["isInt32Array", new Int32Array(1), true],
	["isUint32Array", new Uint32Array(1), true],
	["isFloat32Array", new Float32Array(1), true],
	["isFloat64Array", new Float64Array(1), true],
	["isBigInt64Array", new BigInt64Array(1), true],
	["isBigUint64Array", new BigUint64Array(1), true],
];
for (const [name, value, expected] of typeCases) {
	check(types[name](value) === expected, `types.${name} positive`);
	check(types[name]({}) === false, `types.${name} negative`);
	check(types[name].length === 1, `types.${name} arity`);
}
check(types.isPromise(Promise.resolve()), "types.isPromise positive");
check(!types.isPromise({ then() {} }), "types.isPromise rejects thenables");
check(!types.isExternal({}), "types.isExternal rejects ordinary objects");
check(!types.isKeyObject({}), "types.isKeyObject rejects ordinary objects");
check(!types.isCryptoKey({}), "types.isCryptoKey rejects ordinary objects");
const circular = {};
circular.self = circular;
check(inspect(circular) === "{ self: [Circular] }", "cycle inspection");

function Parent() {}
Parent.prototype.value = function () {
	return 7;
};
function Child() {}
inherits(Child, Parent);
const child = new Child();
check(child instanceof Child && child instanceof Parent, "inherits prototype chain");
check(Child.super_ === Parent && child.value() === 7, "inherits metadata and methods");

let calls = 0;
const wrapped = deprecate(function (value) {
	calls++;
	return this.base + value;
}, "test warning");
check(wrapped.call({ base: 2 }, 3) === 5, "deprecate forwards this and arguments");
check(wrapped.call({ base: 3 }, 4) === 7 && calls === 2, "deprecate remains callable");

function Legacy(value) {
	this.value = value;
}
const DeprecatedLegacy = deprecate(Legacy, "legacy warning");
const legacy = new DeprecatedLegacy(9);
check(
	legacy instanceof Legacy && legacy instanceof DeprecatedLegacy && legacy.value === 9,
	"deprecate preserves construction",
);

console.log("RESULT " + passed + "/" + total);
