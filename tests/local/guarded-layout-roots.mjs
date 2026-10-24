const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof gc !== "function")
	throw new Error("guarded-layout-roots requires explicit GC");

function slotRead(holder) {
	const value = holder.value;
	holder.value = null;
	try {
		const result = value.x;
		gc();
		return [value.marker, result];
	} catch (error) {
		gc();
		return [value.marker, error.marker];
	}
}
globalThis.slotRead = slotRead;

function slotWrite(holder) {
	const value = holder.value;
	holder.value = null;
	try {
		value.x = 123;
		const result = value.x;
		gc();
		return [value.marker, result];
	} catch (error) {
		gc();
		return [value.marker, error.marker];
	}
}
globalThis.slotWrite = slotWrite;

function slotLength(holder) {
	const value = holder.value;
	holder.value = null;
	try {
		const result = value.length;
		gc();
		return [value.marker, result];
	} catch (error) {
		gc();
		return [value.marker, error.marker];
	}
}
globalThis.slotLength = slotLength;

function slotAlias(holder) {
	let value = holder.value;
	holder.value = null;
	value = value.x;
	gc();
	return [value.marker, value.payload];
}
globalThis.slotAlias = slotAlias;

function own(marker) {
	return { marker, x: 17 };
}
let serial = 0;
function invoke(name, create, expected) {
	const marker = ++serial;
	const holder = { value: create(marker) };
	const result = globalThis[name](holder);
	const actual = result[1];
	if (
		holder.value !== null ||
		result[0] !== marker ||
		(actual && typeof actual === "object" ? actual.marker : actual) !== expected
	)
		throw new Error("lost layout root in " + name);
}
for (let i = 0; i < 3; i++) {
	invoke("slotRead", own, 17);
	invoke("slotWrite", own, 123);
	invoke("slotLength", (marker) => Object.assign([1, 2], { marker }), 2);
}
invoke("slotAlias", (marker) => ({ marker: -1, x: { marker, payload: 23 } }), 23);
invoke(
	"slotAlias",
	(marker) => ({
		get x() {
			gc();
			return { marker, payload: 23 };
		},
	}),
	23,
);
invoke(
	"slotRead",
	(marker) => ({
		marker,
		get x() {
			gc();
			return { marker: "read" };
		},
	}),
	"read",
);
invoke(
	"slotWrite",
	(marker) => ({
		marker,
		get x() {
			gc();
			return 123;
		},
		set x(value) {
			gc();
			if (value !== 123) throw new Error("setter");
		},
	}),
	123,
);
for (const [name, key] of [
	["slotRead", "x"],
	["slotWrite", "x"],
	["slotLength", "length"],
]) {
	invoke(
		name,
		(marker) =>
			new Proxy(own(marker), {
				get(target, property, receiver) {
					gc();
					if (property === "length") return { marker: "length" };
					return Reflect.get(target, property, receiver);
				},
				set(target, property, value, receiver) {
					gc();
					return Reflect.set(target, property, value, receiver);
				},
			}),
		name === "slotLength" ? "length" : name === "slotWrite" ? 123 : 17,
	);
	invoke(
		name,
		(marker) =>
			Object.defineProperty({ marker }, key, {
				get() {
					gc();
					throw { marker: "thrown" };
				},
				set() {
					gc();
					throw { marker: "thrown" };
				},
			}),
		"thrown",
	);
}
console.log("guarded-layout-roots PASS");
