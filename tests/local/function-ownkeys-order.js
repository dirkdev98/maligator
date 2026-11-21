import scriptFunctions from "./function-ownkeys-order.cjs";

function record(label, fn) {
	const include = (key) =>
		label !== "sloppy" || (key !== "arguments" && key !== "caller");
	console.log(
		label,
		"reflect",
		JSON.stringify(Reflect.ownKeys(fn).filter(include).map(String)),
	);
	console.log(
		label,
		"names",
		JSON.stringify(Object.getOwnPropertyNames(fn).filter(include)),
	);
}

function moduleFunction() {}
class Base {
	static method() {}
	static field = 1;
}
class Derived extends Base {
	static method() {}
	static field = 1;
}
const methods = { method() {} };
for (const [label, fn] of [
	["sloppy", scriptFunctions.sloppy],
	["strict", scriptFunctions.strict],
	["module", moduleFunction],
	["base class", Base],
	["derived class", Derived],
	["generator", function* () {}],
	["async", async function () {}],
	["async generator", async function* () {}],
	["arrow", () => {}],
	["method", methods.method],
	["bound", moduleFunction.bind(null)],
]) {
	fn[Symbol("first")] = 1;
	fn.extra = 2;
	fn[9] = 3;
	fn[Symbol("second")] = 4;
	fn[2] = 5;
	fn["4294967295"] = 6;
	record(label, fn);
}

function readFirst() {}
readFirst.before = 1;
const originalPrototype = readFirst.prototype;
readFirst.after = 2;
record("read first", readFirst);
console.log(readFirst.prototype === originalPrototype);

function recreatedName() {}
delete recreatedName.name;
Object.defineProperty(recreatedName, "name", { value: "new name" });
recreatedName.extra = 1;
record("recreated name", recreatedName);

function recreatedLength() {}
Object.defineProperty(recreatedLength, "name", { get: () => "existing name" });
recreatedLength.extra = 1;
delete recreatedLength.length;
Object.defineProperty(recreatedLength, "length", { value: 2 });
record("recreated length", recreatedLength);

const explicitPrototype = () => {};
explicitPrototype.extra = 1;
explicitPrototype.prototype = {};
record("explicit prototype on arrow", explicitPrototype);
