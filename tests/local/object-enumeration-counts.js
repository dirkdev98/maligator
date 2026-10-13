const mode = process.env.ENUM_COUNT_KIND || "keys";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
function keys(record, observe) {
	const snapshot = Object.keys(record);
	observe(record);
	return [snapshot.length, snapshot.length];
}
function values(record, observe) {
	const snapshot = Object.values(record);
	observe(record);
	return [snapshot.length, snapshot.length];
}
function entries(record, observe) {
	const snapshot = Object.entries(record);
	observe(record);
	return [snapshot.length, snapshot.length];
}
function names(record, observe) {
	const snapshot = Object.getOwnPropertyNames(record);
	observe(record);
	return [snapshot.length, snapshot.length];
}
function symbols(record, observe) {
	const snapshot = Object.getOwnPropertySymbols(record);
	observe(record);
	return [snapshot.length, snapshot.length];
}
function unchanged() {
	collectGarbage?.();
}
function mutate(record) {
	delete record.first;
	delete record[0];
	Object.defineProperty(record, "after", {
		get() {
			throw new Error("late getter");
		},
	});
	if (Array.isArray(record)) record.length = 0;
	collectGarbage?.();
}
function input(size, array) {
	const record = array ? [] : { first: -0 };
	for (let index = 0; index < size; index++) record[index] = { index };
	Object.defineProperty(record, "hidden", {
		get() {
			throw new Error("hidden getter");
		},
	});
	Object.defineProperty(record, Symbol("hidden-symbol"), {
		get() {
			throw new Error("symbol getter");
		},
	});
	for (let index = 0; index < size; index++) record[Symbol(`key${index}`)] = index;
	return record;
}
const readers = { keys, values, entries, names, symbols };
const rows = [];
if (mode === "primitive") {
	for (const value of [
		"",
		"a😀b",
		"\ud800x",
		"long".repeat(257),
		true,
		false,
		0,
		-0,
		NaN,
		Infinity,
		9n,
		Symbol("input"),
	])
		for (const read of [keys, values, entries, names, symbols])
			rows.push(read(value, unchanged));
} else if (mode !== "effects") {
	const read = readers[mode];
	for (const size of [0, 8, 16, 17, 129, 257]) {
		rows.push(read(input(size, false), mutate), read(input(size, true), mutate));
	}
	const array = [1, , 3];
	Object.defineProperty(array, "0", { enumerable: false });
	array[10000] = "far";
	rows.push(read(array, unchanged));
	rows.push(read(Object.freeze([1, 2, 3]), unchanged));
	class PrivateRecord {
		#value = 1;
		field = 2;
		read() {
			return this.#value;
		}
	}
	rows.push(read(new PrivateRecord(), unchanged));
	const symbolsOnly = new Array(1000000);
	symbolsOnly[Symbol("one")] = 1;
	rows.push(read(symbolsOnly, unchanged));
} else {
	const events = [];
	function accessor() {
		const record = {};
		Object.defineProperty(record, "first", {
			enumerable: true,
			get() {
				events.push("get:first");
				delete record.deleted;
				Object.defineProperty(record, "hidden", { enumerable: true });
				record.added = 9;
				collectGarbage?.();
				return { held: 1 };
			},
		});
		record.deleted = 2;
		Object.defineProperty(record, "hidden", { configurable: true, value: 3 });
		return record;
	}
	for (const read of [keys, values, entries, names, symbols])
		rows.push(read(accessor(), unchanged));
	for (const read of [values, entries]) {
		let calls = 0;
		const marker = { marker: 1 };
		try {
			read(
				{
					early: 1,
					get failure() {
						calls++;
						collectGarbage?.();
						throw marker;
					},
				},
				unchanged,
			);
			throw new Error("missing accessor throw");
		} catch (error) {
			if (error !== marker || calls !== 1) throw new Error("replayed getter");
		}
	}
	const symbol = Symbol("own");
	for (const read of [keys, values, entries, names, symbols]) {
		const target = { first: 1, hidden: 2, [symbol]: 3 };
		const proxy = new Proxy(target, {
			ownKeys() {
				events.push("keys");
				collectGarbage?.();
				return [symbol, "hidden", "first"];
			},
			getOwnPropertyDescriptor(object, key) {
				events.push(`desc:${String(key)}`);
				return Reflect.getOwnPropertyDescriptor(object, key);
			},
			get(object, key) {
				events.push(`get:${String(key)}`);
				return Reflect.get(object, key);
			},
		});
		rows.push(read(proxy, unchanged));
	}
	for (const primitive of ["a😀b", 1, true, Symbol("primitive"), 2n])
		for (const read of [keys, values, entries, names, symbols])
			rows.push(read(primitive, unchanged));
	for (const read of [keys, values, entries, names, symbols]) {
		try {
			read(null, unchanged);
			throw new Error("missing nullish error");
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
