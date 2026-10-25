const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
function conditionalKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "field";
	return { [key]: value };
}
function conditionalProtoKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "__proto__";
	return { [key]: value };
}
function liveInitializer(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : "field";
	return { [key]: observe(value) };
}
function conditionalSymbolKey(flag, value, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	const key = flag !== flag ? observe("key") : Symbol.for("stable-key");
	return { [key]: value };
}
globalThis.computedKey = conditionalKey;
globalThis.computedProtoKey = conditionalProtoKey;
globalThis.computedLive = liveInitializer;
globalThis.computedSymbolKey = conditionalSymbolKey;
const rows = [];
for (let round = 0; round < 8; round++) {
	let order = "";
	const value = { round, parts: [round, "retained"] };
	const symbol = Symbol("dynamic");
	const key = {
		[Symbol.toPrimitive](hint) {
			order += hint;
			collectGarbage?.();
			return round % 2 === 0 ? symbol : "dynamic";
		},
	};
	function observe(input) {
		order += typeof input === "number" ? input : typeof input === "string" ? input : "v";
		collectGarbage?.();
		return input === "key" ? key : input;
	}
	globalThis.keyObserver = observe;
	const plain = conditionalKey("string", value, globalThis.keyObserver);
	const proto = conditionalProtoKey("string", value, globalThis.keyObserver);
	const live = liveInitializer("string", value, globalThis.keyObserver);
	collectGarbage?.();
	for (const object of [plain, live]) {
		const descriptor = Object.getOwnPropertyDescriptor(object, "field");
		if (
			object.field !== value ||
			object.field.parts[0] !== round ||
			!descriptor.enumerable ||
			!descriptor.configurable ||
			!descriptor.writable
		)
			throw new Error("literal key definition");
	}
	if (
		!Object.hasOwn(proto, "__proto__") ||
		proto.__proto__ !== value ||
		Object.getPrototypeOf(proto) !== Object.prototype ||
		order !== "010101v"
	)
		throw new Error("computed prototype key or initializer order");
	rows.push(order);
	order = "";
	const dynamic = conditionalKey(NaN, value, globalThis.keyObserver);
	collectGarbage?.();
	const property = round % 2 === 0 ? symbol : "dynamic";
	if (
		!Object.hasOwn(dynamic, property) ||
		dynamic[property] !== value ||
		order !== "01keystring"
	)
		throw new Error("dynamic property coercion");
	rows.push(order);
	order = "";
	const dynamicProto = conditionalProtoKey(NaN, value, globalThis.keyObserver);
	const dynamicLive = liveInitializer(NaN, value, globalThis.keyObserver);
	if (
		dynamicProto[property] !== value ||
		dynamicLive[property] !== value ||
		order !== "01keystring01keystringv"
	)
		throw new Error("dynamic prototype key or initializer order");
	order = "";
	const symbolResult = conditionalSymbolKey("string", value, globalThis.keyObserver);
	const dynamicSymbol = conditionalSymbolKey(NaN, value, globalThis.keyObserver);
	collectGarbage?.();
	if (
		symbolResult[Symbol.for("stable-key")] !== value ||
		dynamicSymbol[property] !== value ||
		order !== "0101keystring"
	)
		throw new Error("boxed Symbol key or dynamic fallback");
}
for (const value of [undefined, null, 123n, Symbol("value"), "𝌆", -0]) {
	const result = globalThis.computedKey("string", value, () => collectGarbage?.());
	collectGarbage?.();
	if (!Object.is(result.field, value)) throw new Error("mixed property value");
}
let order = "";
const thrown = { thrown: true };
const badKey = {
	[Symbol.toPrimitive]() {
		order += "coerce";
		collectGarbage?.();
		throw thrown;
	},
};
try {
	conditionalKey(NaN, null, (value) => {
		order += value;
		return badKey;
	});
	throw new Error("missing property coercion exception");
} catch (caught) {
	if (caught !== thrown || order !== "01keycoerce")
		throw new Error("property coercion exception order");
}
order = "";
try {
	liveInitializer("string", "throw", (value) => {
		order += value;
		collectGarbage?.();
		if (value === "throw") throw thrown;
		return value;
	});
	throw new Error("missing property initializer exception");
} catch (caught) {
	if (caught !== thrown || order !== "01throw")
		throw new Error("property initializer exception order");
}
let inheritedWrites = 0;
const mutable = process.env.MAL_PRIMORDIALS !== "locked";
if (mutable)
	Object.defineProperty(Object.prototype, "field", {
		configurable: true,
		set() {
			inheritedWrites++;
		},
	});
try {
	const result = conditionalKey("string", "value", () => collectGarbage?.());
	if (result.field !== "value" || !Object.hasOwn(result, "field"))
		throw new Error("inherited property setter intercepted definition");
} finally {
	if (mutable) delete Object.prototype.field;
}
if (inheritedWrites !== 0) throw new Error("inherited property setter ran");
if (mutable) {
	const original = Symbol.for;
	Symbol.for = () => "replaced";
	try {
		const result = conditionalSymbolKey("string", "value", () => collectGarbage?.());
		if (result.replaced !== "value") throw new Error("replaced Symbol producer fallback");
	} finally {
		Symbol.for = original;
	}
}
rows.push(order, inheritedWrites);
console.log(JSON.stringify(rows));
