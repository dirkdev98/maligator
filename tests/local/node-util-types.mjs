import util from "node:util";
import * as named from "node:util/types";
import types from "util/types";

const predicates = [
	"isPromise",
	"isAnyArrayBuffer",
	"isArrayBuffer",
	"isSharedArrayBuffer",
	"isDataView",
	"isDate",
	"isMap",
	"isSet",
	"isWeakMap",
	"isWeakSet",
	"isRegExp",
	"isTypedArray",
	"isBoxedPrimitive",
	"isBigIntObject",
	"isBooleanObject",
	"isNumberObject",
	"isStringObject",
	"isSymbolObject",
	"isArrayBufferView",
	"isAsyncFunction",
	"isGeneratorFunction",
	"isGeneratorObject",
	"isModuleNamespaceObject",
	"isProxy",
	"isExternal",
	"isKeyObject",
	"isCryptoKey",
	"isMapIterator",
	"isSetIterator",
	"isInt8Array",
	"isUint8Array",
	"isUint8ClampedArray",
	"isInt16Array",
	"isUint16Array",
	"isInt32Array",
	"isUint32Array",
	"isFloat32Array",
	"isFloat64Array",
	"isBigInt64Array",
	"isBigUint64Array",
];
const values = [
	undefined,
	null,
	1,
	"text",
	{},
	Promise.resolve(1),
	new ArrayBuffer(4),
	new SharedArrayBuffer(4),
	new DataView(new ArrayBuffer(4)),
	new Date(0),
	new Map(),
	new Set(),
	new WeakMap(),
	new WeakSet(),
	/x/,
	new Number(1),
	new Boolean(true),
	new String("x"),
	Object(1n),
	Object(Symbol("s")),
	(function* () {
		yield 1;
	})(),
	named,
	new Map().entries(),
	new Set().values(),
	new Int8Array(1),
	new Uint8Array(1),
	new Uint8ClampedArray(1),
	new Int16Array(1),
	new Uint16Array(1),
	new Int32Array(1),
	new Uint32Array(1),
	new Float32Array(1),
	new Float64Array(1),
	new BigInt64Array(1),
	new BigUint64Array(1),
	Buffer.from([1]),
];
for (const fn of [
	function () {},
	async function () {},
	function* () {},
	async function* () {},
]) {
	values.push(fn, fn.bind(null), new Proxy(fn, {}));
}
const spoof = function () {};
Object.setPrototypeOf(
	spoof,
	Object.getPrototypeOf(async function () {}),
);
values.push(spoof);
let touched = false;
values.push(
	new Proxy(new Uint8Array(1), {
		get() {
			touched = true;
			throw new Error("unexpected read");
		},
	}),
);
console.log(
	JSON.stringify({
		identity:
			types === util.types &&
			named.default === types &&
			process.getBuiltinModule("util/types") === types,
		arrayBufferView: types.isArrayBufferView === ArrayBuffer.isView,
		results: predicates.map((name) => [
			name,
			named[name] === types[name],
			types[name].name,
			types[name].length,
			types[name](),
			...values.map((value) => types[name](value)),
		]),
		touched,
		construct: predicates.map((name) => {
			try {
				const result = Reflect.construct(types[name], [undefined]);
				return [name, result instanceof types[name]];
			} catch (error) {
				return [name, error.name];
			}
		}),
	}),
);
