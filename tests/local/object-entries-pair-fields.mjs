const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const mode = process.env.ENTRY_PAIR_CASE ?? "captured";
const rows = [];
function readPair(record, index, observe) {
	const entries = Object.entries(record);
	observe(record);
	const pair = entries[index];
	const key = pair[0];
	collect();
	const value = pair[1];
	collect();
	return [key, value, entries.length];
}
function readStatic(record) {
	const entries = Object.entries(record);
	collect();
	const pair = entries[0];
	return [pair["0"], pair["1"]];
}
function readJoined(record, index) {
	const pair = Object.entries(record)[index];
	const key = pair[0];
	const length = key.length;
	const value = pair[1];
	collect();
	return [typeof key === "string" ? key : null, length, value];
}
function projectJoined(record, index) {
	return Object.entries(record)[index];
}
function readJoinedWrapper(record, index) {
	const pair = projectJoined(record, index);
	const key = pair[0];
	const length = key.length;
	const value = pair[1];
	collect();
	return [typeof key === "string" ? key : null, length, value];
}
function readJoinedArithmetic(record, index, base) {
	const pair = projectJoined(record, index);
	return base + pair[0].length + pair[1];
}
function readLoop(record) {
	const entries = Object.entries(record);
	let result = "";
	for (let i = 0; i < entries.length; i++) {
		const pair = entries[i];
		collect();
		result += pair[0] + ":" + pair[1].label + ";";
	}
	return result;
}
function readCached(record) {
	const entries = Object.entries(record);
	const first = entries[0];
	first[1] = "changed";
	collect();
	const pair = entries[0];
	return [pair[0], pair[1], first === pair];
}
function readOverlapping(record) {
	const entries = Object.entries(record);
	let previous;
	const result = [];
	for (let i = 0; i < entries.length; i++) {
		const pair = entries[i];
		collect();
		if (previous) result.push(previous[0], previous[1]);
		previous = pair;
	}
	return result;
}
globalThis.entryPairConsumers = {
	readPair,
	readStatic,
	readLoop,
	readJoined,
	readJoinedWrapper,
	readJoinedArithmetic,
};
const unchanged = () => {};
const record = () => ({
	first: { label: "first" },
	second: { label: "second" },
});
if (mode === "captured") {
	for (const index of [
		-0,
		1,
		"0",
		{
			toString() {
				collect();
				return "1";
			},
		},
	])
		rows.push(
			readPair(record(), index, (target) => {
				target.first = null;
				delete target.second;
				collect();
			}),
		);
} else if (mode === "static") {
	rows.push(readStatic(record()));
} else if (mode === "joined") {
	for (const read of [readJoined, readJoinedWrapper])
		for (const index of [-0, 1, "0", { toString: () => "1" }])
			rows.push(read(record(), index));
} else if (mode === "joined-replacement" || mode === "joined-wrapper-replacement") {
	const read = mode === "joined-replacement" ? readJoined : readJoinedWrapper;
	const events = [];
	const marker = { label: "replacement" };
	Object.entries = () => [
		{
			get 0() {
				events.push("key");
				return {
					get length() {
						events.push("length");
						Object.entries = () => [["later", marker]];
						collect();
						return 7;
					},
				};
			},
			get 1() {
				events.push("value");
				collect();
				return marker;
			},
		},
	];
	rows.push(read(record(), 0), read(record(), 0), events);
} else if (mode === "joined-arithmetic" || mode === "joined-arithmetic-throw") {
	const events = [];
	const marker = {};
	const pair = {
		get 0() {
			events.push("key");
			return {
				get length() {
					events.push("length");
					return {
						valueOf() {
							events.push("number");
							collect();
							return 3;
						},
					};
				},
			};
		},
		get 1() {
			events.push("original");
			return 5;
		},
	};
	Object.entries = () => [pair];
	const base = {
		valueOf() {
			events.push("base");
			collect();
			if (mode === "joined-arithmetic-throw") throw marker;
			Object.defineProperty(pair, "1", {
				get() {
					events.push("changed");
					collect();
					return 11;
				},
			});
			return 7;
		},
	};
	try {
		rows.push(readJoinedArithmetic(record(), 0, base));
	} catch (error) {
		rows.push(error === marker);
	}
	rows.push(events);
} else if (mode === "joined-missing") {
	for (const read of [readJoined, readJoinedWrapper]) {
		for (const index of [-1, 9, 0.5, NaN, Infinity]) {
			try {
				rows.push(read(record(), index));
			} catch (error) {
				rows.push(error.name);
			}
		}
	}
} else if (mode === "loop") {
	rows.push(readLoop(record()));
} else if (mode === "large") {
	const target = record();
	for (let i = 0; i < 12; i++) target["extra" + i] = { label: "extra" + i };
	rows.push(readPair(target, 13, unchanged));
} else if (mode === "missing") {
	for (const index of [-1, 9, 0.5, NaN, Infinity]) {
		try {
			rows.push(readPair(record(), index, unchanged));
		} catch (error) {
			rows.push(error.name);
		}
	}
} else if (mode === "cached") {
	rows.push(readCached(record()));
} else if (mode === "overlap") {
	rows.push(readOverlapping(record()));
} else if (mode === "getter") {
	const events = [];
	const target = {
		get first() {
			events.push("first");
			delete this.second;
			collect();
			return { label: "getter" };
		},
		second: { label: "deleted" },
	};
	rows.push(readPair(target, 0, unchanged), events);
} else if (mode === "replacement") {
	let reads = 0;
	Object.entries = () => [
		{
			get 0() {
				reads++;
				collect();
				return "replacement";
			},
			get 1() {
				reads++;
				collect();
				return { label: "replacement" };
			},
		},
	];
	rows.push(readPair(record(), 0, unchanged), reads);
}
console.log(JSON.stringify(rows));
