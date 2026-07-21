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
