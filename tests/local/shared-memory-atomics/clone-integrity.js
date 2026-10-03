const out = [];
const log = (label, value) => out.push(`${label}: ${JSON.stringify(value)}`);
const errorName = (fn) => {
	try {
		fn();
		return "none";
	} catch (error) {
		return error.name;
	}
};

{
	const rab = new ArrayBuffer(4, { maxByteLength: 16 });
	new Uint8Array(rab).set([1, 2, 3, 4]);
	const [buffer, fixed, tracking, view] = structuredClone([
		rab,
		new Uint8Array(rab, 1, 2),
		new Uint8Array(rab, 1),
		new DataView(rab, 2),
	]);
	const before = [
		buffer.resizable,
		buffer.maxByteLength,
		buffer.byteLength,
		fixed.length,
		tracking.length,
		view.byteLength,
	];
	buffer.resize(8);
	log("resizable-copy", [
		...before,
		fixed.length,
		tracking.length,
		view.byteLength,
		fixed.buffer === buffer,
		rab.byteLength,
	]);
}

{
	const rab = new ArrayBuffer(4, { maxByteLength: 32 });
	new Uint8Array(rab).set([1, 2, 3, 4]);
	const moved = structuredClone(
		{ buffer: rab, tracking: new Uint8Array(rab) },
		{ transfer: [rab] },
	);
	moved.buffer.resize(6);
	log("resizable-transfer", [
		rab.detached,
		rab.byteLength,
		moved.buffer.resizable,
		moved.buffer.maxByteLength,
		moved.tracking.length,
		Array.from(moved.tracking),
	]);
}

{
	// The view was serialized before the getter shrank its transferred buffer.
	const rab = new ArrayBuffer(8, { maxByteLength: 8 });
	const value = {
		fixed: new Uint8Array(rab, 0, 8),
		get shrink() {
			rab.resize(2);
			return 0;
		},
	};
	const moved = structuredClone(value, { transfer: [rab] });
	const before = [moved.fixed.length, moved.fixed.buffer.byteLength];
	moved.fixed.buffer.resize(8);
	log("resizable-shrunk-view", [...before, moved.fixed.length]);
}

{
	const sab = new SharedArrayBuffer(4, { maxByteLength: 16 });
	const [tracking, fixed] = structuredClone([
		new Uint8Array(sab),
		new Uint8Array(sab, 0, 2),
	]);
	sab.grow(8);
	log("growable-views", [
		tracking.length,
		fixed.length,
		tracking.buffer.growable,
		tracking.buffer.maxByteLength,
	]);
}

{
	const listed = new ArrayBuffer(4);
	const other = new ArrayBuffer(4);
	const value = {
		listed,
		get detachOther() {
			other.transfer();
			return 1;
		},
	};
	const name = errorName(() => structuredClone(value, { transfer: [listed, other] }));
	log("getter-detach-transfer", [
		name,
		listed.detached,
		listed.byteLength,
		other.detached,
	]);
	const copied = new ArrayBuffer(4);
	const late = {
		get detach() {
			copied.transfer();
			return 1;
		},
		copied,
	};
	log(
		"getter-detach-copy",
		errorName(() => structuredClone(late)),
	);
	const listedFirst = new ArrayBuffer(4);
	const swappedIn = new ArrayBuffer(8);
	const transfer = [listedFirst];
	const swapping = {
		get swap() {
			transfer[0] = swappedIn;
			return 1;
		},
		swappedIn,
	};
	const swapped = structuredClone(swapping, { transfer });
	log("transfer-list-snapshot", [
		listedFirst.detached,
		swappedIn.detached,
		swapped.swappedIn.byteLength,
	]);
}

{
	const inner = new TypeError("inner");
	const error = new Error("outer", { cause: inner });
	const clone = structuredClone(error);
	const cause = Object.getOwnPropertyDescriptor(clone, "cause");
	log("error-cause", [
		clone.cause instanceof TypeError,
		clone.cause.message,
		cause.enumerable,
		cause.writable,
		clone.cause !== inner,
	]);
	const stack = Object.getOwnPropertyDescriptor(clone, "stack");
	log("error-stack", [typeof clone.stack, clone.stack === error.stack, stack.enumerable]);
	const self = new Error("self");
	self.cause = self;
	const selfClone = structuredClone(self);
	log("error-cause-cycle", selfClone.cause === selfClone);
}

{
	const reads = { name: 0, message: 0, stack: 0, cause: 0 };
	const error = new RangeError();
	Object.defineProperty(error, "name", {
		get() {
			reads.name++;
			return "TypeError";
		},
	});
	Object.defineProperty(error, "message", {
		get() {
			reads.message++;
			return "m";
		},
	});
	Object.defineProperty(error, "stack", {
		get() {
			reads.stack++;
			return "custom stack";
		},
	});
	Object.defineProperty(error, "cause", {
		get() {
			reads.cause++;
			return 1;
		},
	});
	const clone = structuredClone(error);
	log("error-getters", [
		Object.getPrototypeOf(clone) === TypeError.prototype,
		Object.hasOwn(clone, "message"),
		clone.stack,
		"cause" in clone,
		reads,
	]);
}

{
	const re = /x/g;
	re.lastIndex = 5;
	re.extra = 1;
	const clone = structuredClone(re);
	log("regexp-reset", [clone.lastIndex, "extra" in clone, re.lastIndex, clone.global]);
}

{
	const number = new Number(1);
	number.extra = 1;
	const [negativeZero, big, string, plain] = structuredClone([
		Object(-0),
		Object(-(2n ** 64n)),
		Object("é"),
		number,
	]);
	log("boxed-edge", [
		Object.is(negativeZero.valueOf(), -0),
		typeof big,
		big.valueOf() === -(2n ** 64n),
		string.length,
		string[0],
		"extra" in plain,
	]);
}

{
	const array = [, "b"];
	array.length = 4;
	array.named = { deep: true };
	Object.defineProperty(array, "hidden", { value: 1, enumerable: false });
	const clone = structuredClone(array);
	log("array-props", [
		clone.length,
		0 in clone,
		clone[1],
		3 in clone,
		clone.named.deep,
		"hidden" in clone,
		Object.keys(clone),
	]);
	const growing = [1, 2];
	Object.defineProperty(growing, 0, {
		get() {
			growing.push(3);
			return 1;
		},
		enumerable: true,
		configurable: true,
	});
	const grown = structuredClone(growing);
	log("array-getter-grow", [grown.length, Object.keys(grown), growing.length]);
}

console.log(out.join("\n"));
