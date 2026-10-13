const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const mode = process.env.REFLECT_KEYS_MODE ?? "snapshot";
const locked = process.env.MAL_PRIMORDIALS === "locked";
function ownCount(record, observe) {
	const snapshot = Reflect.ownKeys(record);
	observe(record);
	return snapshot.length;
}
function ownSnapshot(record, observe) {
	const snapshot = Reflect.ownKeys(record);
	observe(record);
	const result = [];
	for (let index = 0; index < snapshot.length; index++) result.push(snapshot[index]);
	return result;
}
function ownMaterialize(record, key, observe) {
	const snapshot = Reflect.ownKeys(record);
	const first = snapshot[key];
	observe();
	return [first, snapshot[0], snapshot.length];
}
function ownIgnored(record, observe, unused) {
	const snapshot = Reflect.ownKeys(record, observe(record), unused);
	return [snapshot.length, snapshot[0]];
}
globalThis.readOwnIgnored = ownIgnored;
globalThis.readOwnCount = ownCount;
globalThis.readOwnSnapshot = ownSnapshot;
globalThis.readOwnMaterialize = ownMaterialize;
const left = Symbol("left"),
	right = Symbol("right");
const output = [];
function assertKeys(actual, expected) {
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	)
		throw new Error("own key order or identity");
	output.push(
		actual.map((key) => (typeof key === "symbol" ? `symbol:${key.description}` : key)),
	);
}
function record(array, size) {
	const value = array ? [] : {};
	value[left] = "first symbol";
	for (let index = size - 1; index >= 0; index--) value[index * 2] = index;
	Object.defineProperty(value, "hidden", {
		get() {
			throw new Error("key enumeration invoked getter");
		},
		configurable: true,
	});
	value.label = "label";
	value[right] = "second symbol";
	return value;
}
if (mode === "snapshot") {
	for (const array of [false, true]) {
		for (const size of [0, 1, 4, 10, 16, 32]) {
			const value = record(array, size);
			const expected = Reflect.ownKeys(value);
			const actual = globalThis.readOwnSnapshot(value, (value) => {
				delete value[0];
				delete value[left];
				delete value.hidden;
				value.late = "late";
				value[Symbol("late")] = 1;
				collectGarbage();
			});
			assertKeys(actual, expected);
		}
	}
	class Private {
		#hidden = 1;
		visible = 2;
		read() {
			return this.#hidden;
		}
	}
	const privateValue = new Private();
	privateValue[right] = 3;
	assertKeys(globalThis.readOwnSnapshot(privateValue, collectGarbage), [
		"visible",
		right,
	]);
} else if (mode === "count") {
	for (const array of [false, true]) {
		for (const size of [0, 8, 16, 17, 129, 257]) {
			const value = record(array, size),
				expected = Reflect.ownKeys(value).length;
			const actual = globalThis.readOwnCount(value, (value) => {
				delete value[left];
				value.extra = 1;
				collectGarbage();
			});
			if (actual !== expected) throw new Error("count was not an eager snapshot");
			output.push(actual);
		}
	}
	const sparse = [];
	sparse.length = 0xffffffff;
	sparse[right] = 1;
	const count = globalThis.readOwnCount(sparse, collectGarbage);
	if (count !== 2) throw new Error("sparse length");
	output.push(count);
} else if (mode === "ignored") {
	const events = [];
	for (const unused of [
		left,
		1n,
		{
			valueOf() {
				throw new Error("ignored valueOf");
			},
			toString() {
				throw new Error("ignored toString");
			},
		},
	]) {
		const value = { before: 1 };
		assertKeys(
			globalThis.readOwnIgnored(
				value,
				(value) => {
					events.push("arg");
					delete value.before;
					value.after = 2;
					collectGarbage();
				},
				unused,
			),
			[1, "after"],
		);
	}
	const marker = {};
	let thrown;
	try {
		globalThis.readOwnIgnored(
			{},
			() => {
				throw marker;
			},
			left,
		);
	} catch (error) {
		thrown = error;
	}
	if (thrown !== marker || events.join() !== "arg,arg,arg")
		throw new Error("ignored argument order");
} else if (mode === "materialize") {
	let cached;
	if (!locked)
		Object.defineProperty(Array.prototype, "captureOwnKeys", {
			configurable: true,
			get() {
				cached = this;
				collectGarbage();
				return this[0];
			},
		});
	try {
		let conversions = 0;
		const key = {
			[Symbol.toPrimitive]() {
				conversions++;
				collectGarbage();
				return locked ? "0" : "captureOwnKeys";
			},
		};
		for (const array of [false, true]) {
			const value = record(array, 2),
				expected = Reflect.ownKeys(value);
			const actual = globalThis.readOwnMaterialize(value, key, () => {
				if (!locked) {
					cached[0] = right;
					cached.length = 2;
				}
				collectGarbage();
			});
			assertKeys(actual, [
				expected[0],
				locked ? expected[0] : right,
				locked ? expected.length : 2,
			]);
		}
		if (conversions !== 2) throw new Error("key conversion replayed");
	} finally {
		if (!locked) delete Array.prototype.captureOwnKeys;
	}
} else {
	for (const value of [undefined, null, 1, 1n, true, "hi", left]) {
		let thrown;
		try {
			globalThis.readOwnCount(value, collectGarbage);
		} catch (error) {
			thrown = error;
		}
		if (!(thrown instanceof TypeError)) throw new Error("primitive did not throw");
		output.push("TypeError");
	}
	for (const value of [Object("a\ud800"), new Uint8Array([1, 2]), function sample() {}])
		assertKeys(globalThis.readOwnSnapshot(value, collectGarbage), Reflect.ownKeys(value));
	const events = [];
	const proxy = new Proxy(
		{},
		{
			ownKeys() {
				events.push("keys");
				collectGarbage();
				return [right, "x", left];
			},
			getOwnPropertyDescriptor() {
				throw new Error("unexpected descriptor trap");
			},
			get() {
				throw new Error("unexpected get trap");
			},
		},
	);
	assertKeys(
		globalThis.readOwnSnapshot(proxy, () => events.push("observe")),
		[right, "x", left],
	);
	if (events.join() !== "keys,observe") throw new Error("Proxy observation order");
	const original = {};
	const revoked = Proxy.revocable(original, {});
	revoked.revoke();
	let threw = false;
	try {
		globalThis.readOwnSnapshot(revoked.proxy, collectGarbage);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	if (!threw) throw new Error("revoked proxy");
	if (!locked) {
		const saved = Reflect.ownKeys;
		Reflect.ownKeys = (value) => {
			if (value !== original) throw new Error("override target");
			return [right, "custom"];
		};
		try {
			assertKeys(globalThis.readOwnSnapshot(original, collectGarbage), [right, "custom"]);
		} finally {
			Reflect.ownKeys = saved;
		}
	}
}
console.log(JSON.stringify(output));
