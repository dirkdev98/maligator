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
globalThis.entryPairConsumers = { readPair, readStatic, readLoop };
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
