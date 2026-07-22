import assertModule, { equal } from "node:assert/strict";
import netModule, { isIP } from "node:net";
import osModule, { release } from "node:os";
import querystringModule, { parse as parseQuery } from "node:querystring";
import urlModule, { Url, parse as parseUrl } from "node:url";

const checks = [];

function checkAccessor(target, key, getName, setName, enumerable = false) {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	checks.push(
		descriptor !== undefined,
		descriptor.enumerable === enumerable,
		descriptor.configurable === true,
		descriptor.get?.name === getName,
		descriptor.get?.length === 0,
		setName === undefined
			? descriptor.set === undefined
			: descriptor.set?.name === setName && descriptor.set?.length === 1,
	);
}

checks.push(
	equal === assertModule.equal,
	isIP === netModule.isIP,
	release === osModule.release,
	parseQuery === querystringModule.parse,
	Url === urlModule.Url,
	parseUrl === urlModule.parse,
	isIP("127.0.0.1") === 4,
	typeof release() === "string",
	parseQuery("a=b").a === "b",
	parseUrl("/path").pathname === "/path",
);

const undefinedValue = undefined;
const objectValue = {};
const booleanValue = true;
const numberValue = 1;
const stringValue = "value";
const symbolValue = Symbol("value");
const bigintValue = 1n;
const functionValue = function () {};

checks.push(
	typeof undefinedValue === "undefined",
	"undefined" === typeof undefinedValue,
	typeof undefinedValue == "undefined",
	"undefined" == typeof undefinedValue,
	!(typeof undefinedValue !== "undefined"),
	!("undefined" !== typeof undefinedValue),
	!(typeof undefinedValue != "undefined"),
	!("undefined" != typeof undefinedValue),
	typeof objectValue === "object",
	"object" === typeof objectValue,
	typeof objectValue == "object",
	"object" == typeof objectValue,
	!(typeof objectValue !== "object"),
	!("object" !== typeof objectValue),
	!(typeof objectValue != "object"),
	!("object" != typeof objectValue),
	typeof booleanValue === "boolean",
	"boolean" === typeof booleanValue,
	typeof booleanValue == "boolean",
	"boolean" == typeof booleanValue,
	!(typeof booleanValue !== "boolean"),
	!("boolean" !== typeof booleanValue),
	!(typeof booleanValue != "boolean"),
	!("boolean" != typeof booleanValue),
	typeof numberValue === "number",
	"number" === typeof numberValue,
	typeof numberValue == "number",
	"number" == typeof numberValue,
	!(typeof numberValue !== "number"),
	!("number" !== typeof numberValue),
	!(typeof numberValue != "number"),
	!("number" != typeof numberValue),
	typeof stringValue === "string",
	"string" === typeof stringValue,
	typeof stringValue == "string",
	"string" == typeof stringValue,
	!(typeof stringValue !== "string"),
	!("string" !== typeof stringValue),
	!(typeof stringValue != "string"),
	!("string" != typeof stringValue),
	typeof symbolValue === "symbol",
	"symbol" === typeof symbolValue,
	typeof symbolValue == "symbol",
	"symbol" == typeof symbolValue,
	!(typeof symbolValue !== "symbol"),
	!("symbol" !== typeof symbolValue),
	!(typeof symbolValue != "symbol"),
	!("symbol" != typeof symbolValue),
	typeof bigintValue === "bigint",
	"bigint" === typeof bigintValue,
	typeof bigintValue == "bigint",
	"bigint" == typeof bigintValue,
	!(typeof bigintValue !== "bigint"),
	!("bigint" !== typeof bigintValue),
	!(typeof bigintValue != "bigint"),
	!("bigint" != typeof bigintValue),
	typeof functionValue === "function",
	"function" === typeof functionValue,
	typeof functionValue == "function",
	"function" == typeof functionValue,
	!(typeof functionValue !== "function"),
	!("function" !== typeof functionValue),
	!(typeof functionValue != "function"),
	!("function" != typeof functionValue),
	typeof null === "object",
);

let mutableTypeofValue = 1;
const savedTypeof = typeof mutableTypeofValue;
mutableTypeofValue = function () {};

let getterReads = 0;
const getterSource = {
	get value() {
		getterReads++;
		return 1;
	},
};
let callReads = 0;
function callSource() {
	callReads++;
	return null;
}
const dynamicTypeofTag = "number";
const standaloneTypeof = typeof numberValue;
checks.push(
	savedTypeof === "number",
	typeof getterSource.value === "number",
	getterReads === 1,
	typeof callSource() === "object",
	callReads === 1,
	typeof numberValue === dynamicTypeofTag,
	!(typeof numberValue === "Number"),
	standaloneTypeof.length === 6,
	standaloneTypeof.charCodeAt(0) === 110,
);

checkAccessor(ArrayBuffer.prototype, "byteLength", "get byteLength");
checkAccessor(DataView.prototype, "byteOffset", "get byteOffset");
checkAccessor(Map.prototype, "size", "get size");
checkAccessor(Set.prototype, "size", "get size");
checkAccessor(Symbol.prototype, "description", "get description");
checkAccessor(RegExp.prototype, "flags", "get flags");
checkAccessor(
	Object.getPrototypeOf(Uint8Array.prototype),
	Symbol.toStringTag,
	"get [Symbol.toStringTag]",
);
checkAccessor(Object.prototype, "__proto__", "get __proto__", "set __proto__");
checkAccessor(Error.prototype, "stack", "get stack", "set stack");
checkAccessor(ArrayBuffer, Symbol.species, "get [Symbol.species]");
if (typeof Iterator === "function") {
	checkAccessor(Iterator.prototype, "constructor", "get constructor", "set constructor");
	checkAccessor(
		Iterator.prototype,
		Symbol.toStringTag,
		"get [Symbol.toStringTag]",
		"set [Symbol.toStringTag]",
	);
}

function hasFunctionMetadata(fn, length, name) {
	const lengthDescriptor = Object.getOwnPropertyDescriptor(fn, "length");
	const nameDescriptor = Object.getOwnPropertyDescriptor(fn, "name");
	const keys = Reflect.ownKeys(fn);
	return (
		fn.length === length &&
		fn.name === name &&
		keys[0] === "length" &&
		keys[1] === "name" &&
		lengthDescriptor.value === length &&
		lengthDescriptor.writable === false &&
		lengthDescriptor.enumerable === false &&
		lengthDescriptor.configurable === true &&
		nameDescriptor.value === name &&
		nameDescriptor.writable === false &&
		nameDescriptor.enumerable === false &&
		nameDescriptor.configurable === true
	);
}

function scriptMetadata(first, second) {
	return first + second;
}
const nativeMetadata = Array.prototype.map;
const boundMetadata = scriptMetadata.bind(undefined, 1);
const computedMetadataKey = "computed" + "Metadata";
const computedMetadata = {
	[computedMetadataKey]: (value) => value,
}[computedMetadataKey];
checks.push(
	hasFunctionMetadata(scriptMetadata, 2, "scriptMetadata"),
	hasFunctionMetadata(nativeMetadata, 1, "map"),
	hasFunctionMetadata(boundMetadata, 1, "bound scriptMetadata"),
	hasFunctionMetadata(computedMetadata, 1, "computedMetadata"),
);

const redefinedMetadata = (value) => value;
Object.defineProperty(redefinedMetadata, "name", {
	value: "redefined",
	configurable: true,
});
checks.push(hasFunctionMetadata(redefinedMetadata, 1, "redefined"));

const deletedMetadata = (value) => value;
checks.push(
	delete deletedMetadata.name,
	Reflect.ownKeys(deletedMetadata).join("|") === "length",
	Reflect.defineProperty(deletedMetadata, "name", {
		value: "restored",
		configurable: true,
	}),
	hasFunctionMetadata(deletedMetadata, 1, "restored"),
);

const nonExtensibleMetadata = (value) => value;
Object.preventExtensions(nonExtensibleMetadata);
checks.push(
	hasFunctionMetadata(nonExtensibleMetadata, 1, "nonExtensibleMetadata"),
	!Object.isExtensible(nonExtensibleMetadata),
	delete nonExtensibleMetadata.name,
	!Reflect.defineProperty(nonExtensibleMetadata, "name", {
		value: "blocked",
		configurable: true,
	}),
);

const sealedMetadata = (value) => value;
Object.seal(sealedMetadata);
checks.push(
	Object.isSealed(sealedMetadata),
	!Object.getOwnPropertyDescriptor(sealedMetadata, "length").configurable,
	!Object.getOwnPropertyDescriptor(sealedMetadata, "name").configurable,
);

const frozenMetadata = scriptMetadata.bind(undefined);
Object.freeze(frozenMetadata);
checks.push(
	Object.isFrozen(frozenMetadata),
	!Object.getOwnPropertyDescriptor(frozenMetadata, "length").writable,
	!Object.getOwnPropertyDescriptor(frozenMetadata, "name").writable,
);

let metadataChurn = 0;
for (let index = 0; index < 256; index++) {
	const fn = (first, second) => first + second + index;
	const bound = fn.bind(undefined, index);
	metadataChurn += fn.length + bound.length;
}
checks.push(metadataChurn === 768);

const shapedA = {};
const shapedB = {};
shapedA[["shared", "Key"].join("")] = 1;
shapedB[["sharedK", "ey"].join("")] = 2;
checks.push(shapedA.sharedKey === 1, shapedB.sharedKey === 2);

const dictionary = {};
for (let index = 0; index < 40; index++) dictionary["key" + index] = index;
checks.push(dictionary[["key", 39].join("")] === 39);

const ensured = {};
Object.defineProperty(ensured, "anchor", { value: 1 });
for (let index = 0; index < 20; index++) {
	Reflect.defineProperty(ensured, "ensured" + index, {
		value: index,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
checks.push(
	ensured.ensured19 === 19,
	Reflect.ownKeys(ensured).at(-1) === "ensured19",
	!Reflect.defineProperty(ensured, "anchor", { configurable: true }),
	Object.getOwnPropertyDescriptor(ensured, "anchor").configurable === false,
);
Object.preventExtensions(ensured);
checks.push(
	!Reflect.defineProperty(ensured, "ghost", { value: 1 }),
	!("ghost" in ensured),
);

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
