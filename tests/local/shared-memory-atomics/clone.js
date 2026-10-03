const out = [];
const log = (label, value) => out.push(`${label}: ${JSON.stringify(value)}`);

// DataView keeps its window and aliases the cloned buffer once.
{
	const buffer = new ArrayBuffer(8);
	new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
	const [view, bytes] = structuredClone([
		new DataView(buffer, 2, 4),
		new Uint8Array(buffer),
	]);
	log("dataview", [
		view instanceof DataView,
		view.byteOffset,
		view.byteLength,
		view.getUint8(0),
		view.buffer === bytes.buffer,
	]);
}

{
	const re = /a+b/giu;
	re.lastIndex = 3;
	const clone = structuredClone(re);
	log("regexp", [
		clone instanceof RegExp,
		clone.source,
		clone.flags,
		clone.lastIndex,
		clone !== re,
	]);
}

{
	const error = new RangeError("boom", { cause: "why" });
	error.extra = 1;
	const clone = structuredClone(error);
	const desc = Object.getOwnPropertyDescriptor(clone, "message");
	log("error", [
		clone instanceof RangeError,
		clone.message,
		desc.enumerable,
		desc.writable,
		"extra" in clone,
		clone.cause,
		Object.hasOwn(clone, "stack") && typeof clone.stack === "string",
	]);
	const custom = new Error("x");
	custom.name = "CustomError";
	const customClone = structuredClone(custom);
	log("error-name", [
		Object.getPrototypeOf(customClone) === Error.prototype,
		customClone.name,
		customClone.message,
	]);
	const silent = new TypeError();
	log("error-no-message", Object.hasOwn(structuredClone(silent), "message"));
}

{
	const [n, s, b, big] = structuredClone([
		new Number(3),
		new String("ab"),
		new Boolean(false),
		Object(5n),
	]);
	log("boxed", [
		typeof n,
		n.valueOf(),
		s.valueOf(),
		s.length,
		b.valueOf(),
		typeof big,
		big.valueOf() === 5n,
	]);
	try {
		structuredClone(Object(Symbol("s")));
		log("boxed-symbol", "cloned");
	} catch (error) {
		log("boxed-symbol", error.name);
	}
}

{
	const holes = [1, , 3];
	holes.extra = 7;
	const clone = structuredClone(holes);
	log("holes", [clone.length, 1 in clone, clone[2], clone.extra, Array.isArray(clone)]);
	log("key-order", Object.keys(structuredClone({ b: 1, a: 2, 1: 3 })));
	const deleting = {
		get a() {
			delete this.b;
			return 1;
		},
		b: 2,
	};
	log("getter-delete", Object.keys(structuredClone(deleting)));
	Object.defineProperty(Object.prototype, "trap", {
		set() {
			throw new Error("inherited setter ran");
		},
		configurable: true,
	});
	const created = structuredClone({ trap: 1 });
	delete Object.prototype.trap;
	log("create-data-property", [Object.hasOwn(created, "trap"), created.trap]);
	const proto = structuredClone(JSON.parse('{"__proto__": 5}'));
	log("proto-key", [
		Object.hasOwn(proto, "__proto__"),
		Object.getPrototypeOf(proto) === Object.prototype,
	]);
}

{
	const kept = new ArrayBuffer(8);
	try {
		structuredClone({ f() {}, kept }, { transfer: [kept] });
	} catch (error) {
		log("transfer-failure", [error.name, kept.byteLength]);
	}
	const moved = new ArrayBuffer(8);
	const clone = structuredClone(moved, { transfer: [moved] });
	log("transfer", [moved.byteLength, clone.byteLength]);
	const unreachable = new ArrayBuffer(4);
	structuredClone(1, { transfer: [unreachable] });
	log("transfer-unreachable", unreachable.byteLength);
}

{
	const sab = new SharedArrayBuffer(16);
	const alias = structuredClone(sab);
	new Int32Array(alias)[1] = 42;
	const view = new Int32Array(sab);
	log("sab-alias", [alias !== sab, view[1]]);
	view.fill(7, 2);
	view.copyWithin(0, 2, 3);
	view.set(new Int32Array(alias).subarray(2, 3), 1);
	log("sab-typed", [Array.from(view), view.indexOf(7), view.includes(42)]);
	const bytes = new Uint8Array(sab);
	bytes.fill(0);
	bytes.set([3, 1, 2]);
	bytes.subarray(0, 3).sort();
	log("sab-bytes", [
		Array.from(bytes.subarray(0, 4)),
		bytes.indexOf(2),
		bytes.lastIndexOf(0),
		bytes.includes(3),
	]);
	const data = new DataView(alias);
	data.setUint16(4, 0x1234, true);
	log("sab-dataview", [data.getUint16(4, true), bytes[4], bytes[5]]);
}

{
	const growable = new SharedArrayBuffer(4, { maxByteLength: 16 });
	const tracking = new Uint8Array(growable);
	const other = structuredClone(growable);
	other.grow(12);
	// Growth through another wrapper is visible to this wrapper's views.
	tracking[10] = 5;
	log("sab-grow", [
		tracking.length,
		growable.byteLength,
		new Uint8Array(other)[10],
		tracking[10],
	]);
	try {
		other.grow(8);
	} catch (error) {
		log("sab-shrink", error.name);
	}
}

{
	const cells = new Int32Array(new SharedArrayBuffer(16));
	log("wait-async-sync", [
		Atomics.waitAsync(cells, 0, 1).value,
		Atomics.waitAsync(cells, 0, 0, 0).value,
	]);
	const notified = Atomics.waitAsync(cells, 1, 0);
	const timed = Atomics.waitAsync(cells, 2, 0, 5);
	log("wait-async-pending", [notified.async, timed.async, Atomics.notify(cells, 1)]);
	notified.value.then((value) => log("notified", value));
	timed.value.then((value) => {
		log("timed", value);
	});
	// A referenced timer keeps the loop alive long enough for the unreferenced deadline.
	setTimeout(() => {
		// A lone finite waitAsync must not keep the process alive (Node parity).
		Atomics.waitAsync(cells, 3, 0, 60_000).value.then(() => log("lingered", true));
		console.log(out.join("\n"));
	}, 50);
}
