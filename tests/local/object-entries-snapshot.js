const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const mode = process.env.ENTRIES_CASE ?? "semantics";
const rows = [];
function collect() {
	if (typeof gc === "function") gc();
}
function entriesCount(record, index, observe) {
	const entries = Object.entries(record);
	observe(record);
	collect();
	return entries.length;
}
function entriesIndex(record, index, observe) {
	const entries = Object.entries(record);
	observe(record);
	const pair = entries[index];
	collect();
	const captured = pair[1];
	pair[1] = { label: "pair-mutated" };
	pair.push(99);
	collect();
	return [entries.length, pair === entries[index], captured, entries[index]];
}
function entriesMaterialize(record, index, observe) {
	const entries = Object.entries(record);
	const first = entries[0];
	observe(record);
	collect();
	const result = entries[index];
	collect();
	return [
		first,
		result,
		entries[0],
		entries.length,
		first === entries[0],
		entries[index] === result,
	];
}
function entriesRead(record, index, observe) {
	const entries = Object.entries(record);
	observe(record);
	return [entries[index], entries.length, entries[0]];
}
globalThis.entryConsumers = {
	count: entriesCount,
	index: entriesIndex,
	materialize: entriesMaterialize,
	semantics: entriesRead,
};
const selected = globalThis.entryConsumers[mode];
const unchanged = () => {};
function replace(record) {
	record.a = "new";
	delete record.b;
	collect();
}
function record(i) {
	return {
		a: { label: "a" + i },
		b: { label: "b" + i },
		c: 3,
		d: 4,
		e: 5,
		f: 6,
		g: 7,
		h: 8,
	};
}
if (mode !== "semantics") {
	for (let i = 0; i < 8; i++)
		rows.push(selected(record(i), mode === "materialize" ? "0" : i % 2, replace));
} else {
	for (const index of [-0, 1, "0", -1, 19, 0.5, NaN, Infinity])
		rows.push(selected(record(0), index, unchanged));
	rows.push(selected({}, 0, unchanged));
	rows.push(selected({ 10: "ten", 2: "two", z: "z", a: "a" }, 0, unchanged));
	rows.push(selected("a😀", 1, unchanged));
	rows.push(selected(Object("ab"), 0, unchanged), selected([9, 11], 1, unchanged));
	const large = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };
	rows.push(selected(large, 8, unchanged));
	const special = {
		missing: undefined,
		negative: -0,
		nan: NaN,
		nil: null,
		boolean: true,
	};
	Object.defineProperty(special, "hidden", {
		get() {
			throw new Error("hidden read");
		},
	});
	Object.defineProperty(special, Symbol("symbol"), {
		enumerable: true,
		get() {
			throw new Error("symbol read");
		},
	});
	rows.push(selected(special, 0, unchanged));
	const events = [];
	const accessor = {
		first: 1,
		get second() {
			events.push("get");
			delete this.third;
			collect();
			return 2;
		},
		third: 3,
	};
	rows.push(selected(accessor, 1, unchanged), events.join(","));
	events.length = 0;
	rows.push(entriesCount(accessor, 0, unchanged), events.join(","));
	const proxy = new Proxy(
		{ a: 1, b: 2 },
		{
			ownKeys() {
				events.push("keys");
				return ["b", "a"];
			},
			getOwnPropertyDescriptor(target, key) {
				events.push("desc:" + key);
				return Object.getOwnPropertyDescriptor(target, key);
			},
			get(target, key) {
				events.push("get:" + key);
				return target[key];
			},
		},
	);
	events.length = 0;
	rows.push(selected(proxy, 0, unchanged), events.join(","));
	let coercions = 0;
	rows.push(
		selected(
			record(1),
			{
				toString() {
					coercions++;
					collect();
					return "0";
				},
			},
			unchanged,
		),
		coercions,
	);
	for (const target of [
		null,
		undefined,
		{
			get fail() {
				collect();
				throw new RangeError("entries");
			},
		},
	]) {
		try {
			rows.push(selected(target, 0, unchanged));
		} catch (error) {
			rows.push(error.name);
		}
	}
	if (process.env.MAL_PRIMORDIALS !== "locked") {
		let outer;
		let sameOuter = true;
		Object.defineProperty(Array.prototype, "17", {
			configurable: true,
			get() {
				sameOuter = sameOuter && (outer === undefined || outer === this);
				outer = this;
				this[0][1] = "outer-mutated";
				this.length = 1;
				collect();
				return this;
			},
		});
		const result = entriesMaterialize(record(2), 17, unchanged);
		delete Array.prototype[17];
		rows.push(
			result[0],
			result[2],
			result[3],
			result[4],
			result[5],
			sameOuter,
			outer[0] === result[0],
		);
		const original = Object.entries;
		let calls = 0;
		Object.entries = (target) => {
			calls++;
			collect();
			return [["override", target.answer]];
		};
		rows.push(selected({ answer: 42 }, 0, unchanged), calls);
		Object.entries = original;
		const namespace = {
			get entries() {
				calls++;
				return original;
			},
		};
		function captured(target, prepare) {
			const entries = namespace.entries(prepare(target));
			return [entries[0], entries.length];
		}
		rows.push(
			captured({ a: 7 }, (target) => {
				Object.defineProperty(namespace, "entries", {
					value: () => [["late", 0]],
					configurable: true,
				});
				return target;
			}),
			calls,
		);
	}
}
console.log(JSON.stringify(rows));
