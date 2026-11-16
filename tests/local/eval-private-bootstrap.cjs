const vm = require("node:vm");
const kind = process.env.EVAL_BOOTSTRAP_KIND;
const protection = process.env.EVAL_BOOTSTRAP_PROTECTION;
const property =
	protection.startsWith("clone-") || protection === "bare-sealed"
		? "structuredClone"
		: "__compile";
const print = console.log;
let probes = 0;
const getter = () => {
	probes++;
	throw new Error("compiler getter");
};
const setter = () => {
	probes++;
	throw new Error("compiler setter");
};
if (protection === "accessor" || protection === "clone-accessor") {
	Object.defineProperty(globalThis, property, {
		get: getter,
		set: setter,
		configurable: true,
	});
} else if (protection === "readonly" || protection === "clone-readonly") {
	Object.defineProperty(globalThis, property, {
		value: "reserved",
		writable: false,
		configurable: false,
	});
} else if (protection === "sealed") {
	Object.preventExtensions(globalThis);
} else if (protection === "bare-sealed") {
	delete globalThis.structuredClone;
	Object.preventExtensions(globalThis);
}
function compile(step) {
	const value = 40;
	if (kind === "direct") return eval("value + " + step);
	if (kind === "indirect") return (0, eval)("40 + " + step);
	if (kind === "function") return new Function("return 40 + " + step)();
	return vm.runInThisContext("40 + " + step);
}
function observe(step) {
	try {
		return compile(step);
	} catch (error) {
		return error.name;
	}
}
const values = [observe(1), observe(2)];
const descriptor = Object.getOwnPropertyDescriptor(globalThis, property);
const preserved =
	protection === "accessor" || protection === "clone-accessor"
		? descriptor?.get === getter && descriptor?.set === setter
		: protection === "readonly" || protection === "clone-readonly"
			? descriptor?.value === "reserved" && descriptor.writable === false
			: descriptor === undefined;
print(JSON.stringify([values, probes, preserved]));
