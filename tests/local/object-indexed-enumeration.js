const mode = process.env.ENUM_INDEXED_KIND || "keys";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc;
function count(record, observe) {
	const keys = Object.keys(record);
	observe(record);
	return keys.length;
}
function keys(record, index, observe) {
	const snapshot = Object.keys(record);
	observe(record);
	return [snapshot.length, snapshot[0], snapshot[index], snapshot[0]];
}
function values(record, index, observe) {
	const snapshot = Object.values(record);
	observe(record);
	return [snapshot.length, snapshot[0], snapshot[index], snapshot[0]];
}
function entries(record, index, observe) {
	const snapshot = Object.entries(record);
	const first = snapshot[0];
	observe(record, first);
	return [snapshot.length, first, snapshot[index], snapshot[0], first === snapshot[0]];
}
function unchanged() {
	collectGarbage?.();
}
function mutate(record, first) {
	delete record[0];
	delete record[2];
	record[1] = { label: "changed" };
	delete record.tail;
	record.extra = "later";
	if (Array.isArray(record)) record.length = 0;
	if (first) first[1] = "pair-changed";
	collectGarbage?.();
}
function records() {
	const dense = [{ label: "first" }, -0, { label: "third" }];
	dense.tail = "tail";
	const holey = [, { label: "second" }, , 5];
	holey.tail = "hole-tail";
	const dictionary = [1, 2, 3];
	Object.defineProperty(dictionary, "1", { enumerable: false });
	dictionary[10000] = { label: "far" };
	dictionary.tail = "dictionary-tail";
	const indexed = { 10: "ten", 2: { label: "two" }, 0: "zero", tail: "record-tail" };
	delete indexed.tail;
	indexed.tail = "reinserted";
	const boundary = {
		4294967295: "not-index",
		4294967294: "last-index",
		1: "first-index",
		"01": "leading-zero",
	};
	const nullPrototype = Object.assign(Object.create(null), {
		2: "two",
		0: "zero",
		tail: "null-prototype",
	});
	for (const record of [dense, holey, dictionary, indexed, boundary, nullPrototype]) {
		Object.defineProperty(record, "hidden", {
			get() {
				throw new Error("hidden read");
			},
		});
		Object.defineProperty(record, Symbol("excluded"), {
			enumerable: true,
			get() {
				throw new Error("symbol read");
			},
		});
	}
	return [dense, holey, dictionary, indexed, boundary, nullPrototype];
}
const rows = [];
const observe = mutate;
if (["keys", "values", "entries"].includes(mode)) {
	for (const record of records()) {
		if (mode === "keys") rows.push(keys(record, 1, observe));
		else if (mode === "values") rows.push(values(record, 1, observe));
		else rows.push(entries(record, 1, observe));
	}
	for (const index of [
		"0",
		-1,
		32,
		{
			toString() {
				collectGarbage?.();
				return "0";
			},
		},
	]) {
		const record = [{ label: "held" }, "second"];
		if (mode === "keys") rows.push(keys(record, index, unchanged));
		else if (mode === "values") rows.push(values(record, index, unchanged));
		else rows.push(entries(record, index, mutate));
	}
	const empty = [];
	if (mode === "keys") rows.push(keys(empty, 0, unchanged));
	else if (mode === "values") rows.push(values(empty, 0, unchanged));
	else rows.push(entries(empty, 0, unchanged));
} else if (mode === "count") {
	for (const record of records()) rows.push(count(record, mutate));
	rows.push(count(Object.freeze([1, , 3]), unchanged));
	rows.push(count(Object.seal([1, 2, 3]), unchanged));
	rows.push(count(new Array(10000), unchanged));
} else if (mode === "fallback") {
	const events = [];
	function accessorRecord() {
		const record = [{ label: "first" }, 2, 3];
		Object.defineProperty(record, "1", {
			enumerable: true,
			get() {
				events.push("getter");
				delete record[2];
				record[3] = "late";
				collectGarbage?.();
				return { label: "getter-value" };
			},
		});
		return record;
	}
	rows.push(keys(accessorRecord(), 1, unchanged));
	rows.push(values(accessorRecord(), 1, unchanged));
	rows.push(entries(accessorRecord(), 1, unchanged));
	const inherited = Object.create(Array.prototype);
	Object.defineProperty(inherited, "1", {
		get() {
			throw new Error("inherited read");
		},
	});
	const holey = [1, , 3];
	Object.setPrototypeOf(holey, inherited);
	rows.push(values(holey, 1, unchanged));
	const proxy = new Proxy([1, 2], {
		ownKeys(target) {
			events.push("keys");
			collectGarbage?.();
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			events.push(`desc:${key}`);
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		get(target, key) {
			events.push(`get:${key}`);
			return Reflect.get(target, key);
		},
	});
	rows.push(
		keys(proxy, 1, unchanged),
		values(proxy, 1, unchanged),
		entries(proxy, 1, unchanged),
	);
	for (const size of [8, 9, 16, 17]) {
		const record = Array.from({ length: size }, (_, i) => ({ label: `v${i}` }));
		rows.push(
			keys(record, size - 1, unchanged),
			values(record, size - 1, unchanged),
			entries(record, size - 1, unchanged),
		);
	}
	rows.push(
		values(new Uint16Array([1, 2, 3]), 1, unchanged),
		keys("a😀b", 1, unchanged),
		entries("a😀b", 1, unchanged),
	);
	rows.push(events);
} else throw new Error("unknown enumeration mode");
console.log(JSON.stringify(rows));
