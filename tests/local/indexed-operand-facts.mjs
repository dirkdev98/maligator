const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
const rows = [];
function access(source, key, value) {
	const index = +key;
	source[index] = value;
	return source[index];
}
function named(source, flag, value) {
	const key = flag ? "0" : "tag";
	source[key] = value;
	return source[key];
}
function* generatorAccess(source, key, value) {
	const index = +key;
	source[index] = value;
	yield source[index];
	return source[index];
}
function clamped(key, value) {
	const source = new Uint8ClampedArray(4);
	const index = +key;
	source[index] = +value;
	return source[index];
}
function float(key, value) {
	const source = new Float64Array(4);
	const index = +key;
	source[index] = +value;
	return source[index];
}
function integer(key, value) {
	const source = new Int16Array(4);
	const index = +key;
	source[index] = +value;
	return source[index];
}
function escaped(key, value) {
	const buffer = new ArrayBuffer(32);
	const source = new Float64Array(buffer);
	globalThis.indexedBuffer = buffer;
	const index = +key;
	source[index] = value;
	return source[index];
}
function namedTyped(flag, value) {
	const source = new Float64Array(4);
	const key = flag ? Symbol.for("named") : "tag";
	source[key] = value;
	return source[key];
}
globalThis.indexedAccess = access;
globalThis.indexedNamed = named;
globalThis.indexedGenerator = generatorAccess;
globalThis.indexedClamped = clamped;
globalThis.indexedFloat = float;
globalThis.indexedInteger = integer;
globalThis.indexedEscaped = escaped;
globalThis.indexedNamedTyped = namedTyped;
function show(value) {
	if (Number.isNaN(value)) return "NaN";
	if (Object.is(value, -0)) return "-0";
	return value !== null && typeof value === "object" ? value.tag : String(value);
}
for (const key of [0, -0, 1, -1, 0.5, 4, NaN, Infinity]) {
	for (const value of [0, -0, 2.5, 255.5, 65537.75, NaN, Infinity]) {
		rows.push([
			show(globalThis.indexedClamped(key, value)),
			show(globalThis.indexedFloat(key, value)),
			show(globalThis.indexedInteger(key, value)),
		]);
	}
}
for (let round = 0; round < 4; round++) {
	const value = { tag: "retained:" + round, parts: [round, "𝌆"] };
	for (const source of [[null, null], { 0: null, 1: null }]) {
		if (globalThis.indexedAccess(source, 0, value) !== value)
			throw new Error("indexed managed value");
		collectGarbage?.();
		if (source[0].parts[0] !== round) throw new Error("indexed managed lifetime");
		rows.push(show(globalThis.indexedNamed(source, false, value)));
		rows.push(show(globalThis.indexedNamed(source, true, value)));
		const iterator = globalThis.indexedGenerator(source, 1, value);
		if (iterator.next().value !== value) throw new Error("generator indexed value");
		collectGarbage?.();
		const resumed = { tag: "resumed:" + round };
		source[1] = resumed;
		const final = iterator.next();
		if (!final.done || final.value !== resumed)
			throw new Error("generator indexed resumption");
	}
	for (const flag of [false, true]) {
		if (globalThis.indexedNamedTyped(flag, value) !== value)
			throw new Error("named TypedArray managed value");
	}
}
let order = "";
const retained = { tag: "getter", parts: [1, 2] };
const receiver = {
	get 0() {
		order += "g";
		collectGarbage?.();
		return retained;
	},
	set 0(value) {
		order += value.tag;
		collectGarbage?.();
	},
};
const key = {
	valueOf() {
		order += "k";
		collectGarbage?.();
		return 0;
	},
};
if (globalThis.indexedAccess(receiver, key, { tag: "s" }) !== retained || order !== "ksg")
	throw new Error("indexed accessor order");
rows.push(order);
const thrown = { tag: "thrown" };
for (const index of [0, NaN]) {
	try {
		globalThis.indexedEscaped(index, {
			valueOf() {
				collectGarbage?.();
				throw thrown;
			},
		});
		throw new Error("missing TypedArray conversion exception");
	} catch (error) {
		if (error !== thrown) throw error;
	}
}
try {
	globalThis.indexedEscaped(0, 1n);
	throw new Error("missing TypedArray BigInt exception");
} catch (error) {
	if (!(error instanceof TypeError)) throw error;
}
for (const property of [
	{
		set() {
			collectGarbage?.();
			throw thrown;
		},
	},
	{
		set() {
			collectGarbage?.();
		},
		get() {
			collectGarbage?.();
			throw thrown;
		},
	},
]) {
	const object = {};
	Object.defineProperty(object, "0", property);
	try {
		globalThis.indexedAccess(object, 0, retained);
		throw new Error("missing indexed exception");
	} catch (error) {
		if (error !== thrown) throw error;
	}
}
for (const index of [0, NaN, -1, 0.5]) {
	order = "";
	rows.push(
		show(
			globalThis.indexedEscaped(index, {
				valueOf() {
					order += "v";
					collectGarbage?.();
					globalThis.indexedBuffer.transfer();
					return 9;
				},
			}),
		),
	);
	if (order !== "v") throw new Error("TypedArray value coercion");
}
for (const source of [null, undefined, 0, "readonly"]) {
	try {
		globalThis.indexedAccess(source, 0, retained);
		throw new Error("missing strict indexed exception");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
}
let inherited = 0;
if (process.env.MAL_PRIMORDIALS !== "locked") {
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		get() {
			collectGarbage?.();
			return retained;
		},
		set(value) {
			collectGarbage?.();
			inherited += value === retained ? 1 : 100;
		},
	});
	try {
		const source = new Array(3);
		if (
			globalThis.indexedAccess(source, 1, retained) !== retained ||
			Object.hasOwn(source, 1)
		)
			throw new Error("inherited indexed fallback");
	} finally {
		delete Array.prototype[1];
	}
	if (inherited !== 1) throw new Error("inherited indexed setter count");
}
rows.push(inherited);
console.log(JSON.stringify(rows));
