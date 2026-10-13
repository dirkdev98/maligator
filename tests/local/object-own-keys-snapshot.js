const mode = process.env.OWN_KEYS_KIND || "names";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
function names(record, index, observe) {
	const snapshot = Object.getOwnPropertyNames(record);
	observe(record);
	return [snapshot.length, snapshot[0], snapshot[index], snapshot[0], snapshot.length];
}
function symbols(record, index, observe) {
	const snapshot = Object.getOwnPropertySymbols(record);
	observe(record);
	return [snapshot.length, snapshot[0], snapshot[index], snapshot[0], snapshot.length];
}
function unchanged() {
	collectGarbage?.();
}
function mutate(record) {
	for (const key of Reflect.ownKeys(record)) {
		if (key !== "length") delete record[key];
	}
	if (Array.isArray(record)) record.length = 0;
	record.later = 7;
	record[Symbol("later")] = 8;
	collectGarbage?.();
}
function inputs() {
	class PrivateRecord {
		#hidden = 1;
		visible = 2;
		read() {
			return this.#hidden;
		}
	}
	const dictionary = [1, , 3];
	Object.defineProperty(dictionary, "0", { enumerable: false });
	dictionary[10000] = "far";
	dictionary.tail = "tail";
	const record = { 4294967295: 1, 4294967294: 2, 10: 3, 2: 4, "01": 5, tail: 6 };
	delete record.tail;
	record.tail = 8;
	const values = [
		{ ordinary: 1 },
		[1, , 3],
		dictionary,
		record,
		Object.create(null),
		[],
		new PrivateRecord(),
	];
	for (const value of values) {
		Object.defineProperty(value, "hidden", {
			configurable: true,
			get() {
				throw new Error("own key getter");
			},
		});
		Object.defineProperty(value, Symbol("hidden-symbol"), {
			configurable: true,
			get() {
				throw new Error("symbol getter");
			},
		});
		value[Symbol.for("public-symbol")] = 9;
	}
	return values;
}
const rows = [];
if (mode === "names" || mode === "symbols") {
	for (const record of inputs()) {
		const expectedSymbol = Object.getOwnPropertySymbols(record)[0];
		const row = mode === "names" ? names(record, 1, mutate) : symbols(record, 1, mutate);
		if (mode === "symbols" && (row[1] !== expectedSymbol || row[3] !== expectedSymbol))
			throw new Error("symbol identity");
		rows.push(row);
	}
	const target = Object.freeze([1, , 3]);
	rows.push(
		mode === "names" ? names(target, 0, unchanged) : symbols(target, 0, unchanged),
	);
	for (const empty of [[], new Array(10000)])
		rows.push(
			mode === "names" ? names(empty, 0, unchanged) : symbols(empty, 0, unchanged),
		);
} else if (mode === "materialize") {
	let receiver;
	Object.defineProperty(Array.prototype, "inspectSnapshot", {
		configurable: true,
		get() {
			receiver = this;
			this[0] = "changed";
			this.length = 1;
			collectGarbage?.();
			return this;
		},
	});
	try {
		const key = {
			toString() {
				collectGarbage?.();
				return "inspectSnapshot";
			},
		};
		for (const record of inputs()) {
			const first = names(record, key, mutate);
			if (first[2] !== receiver || first[3] !== "changed" || first[4] !== 1)
				throw new Error("names materialization identity");
			rows.push(first);
		}
		for (const record of inputs()) {
			const second = symbols(record, key, mutate);
			if (second[2] !== receiver || second[3] !== "changed" || second[4] !== 1)
				throw new Error("symbols materialization identity");
			rows.push(second);
		}
	} finally {
		delete Array.prototype.inspectSnapshot;
	}
} else if (mode === "fallback") {
	const events = [];
	const symbol = Symbol("proxy");
	const proxy = new Proxy(
		{},
		{
			ownKeys() {
				events.push("keys");
				collectGarbage?.();
				return ["z", symbol, "1", "a"];
			},
			getOwnPropertyDescriptor() {
				throw new Error("unexpected descriptor read");
			},
			get() {
				throw new Error("unexpected value read");
			},
		},
	);
	rows.push(names(proxy, 2, unchanged), symbols(proxy, 0, unchanged));
	for (const size of [15, 16, 17]) {
		const record = Array.from({ length: size }, (_, index) => index);
		for (let index = 0; index < size; index++) record[Symbol(`s${index}`)] = index;
		rows.push(names(record, size, unchanged), symbols(record, size - 1, mutate));
	}
	for (const value of ["a😀b", 3, true, 9n, Symbol("value"), new Uint16Array([1, 2])])
		rows.push(names(value, 0, unchanged), symbols(value, 0, unchanged));
	for (const value of [null, undefined]) {
		for (const read of [names, symbols]) {
			try {
				read(value, 0, unchanged);
				throw new Error("missing nullish rejection");
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				events.push("type-error");
			}
		}
	}
	if (process.env.MAL_PRIMORDIALS !== "locked") {
		const original = Object.getOwnPropertyNames;
		Object.getOwnPropertyNames = function (record) {
			events.push(`override:${record.value}`);
			return ["overridden"];
		};
		try {
			rows.push(names({ value: 7 }, 0, unchanged));
		} finally {
			Object.getOwnPropertyNames = original;
		}
	}
	rows.push(events);
} else throw new Error("unknown own key mode");
console.log(
	JSON.stringify(rows, (_, value) => (typeof value === "symbol" ? String(value) : value)),
);
