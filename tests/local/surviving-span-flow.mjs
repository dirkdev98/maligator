const rows = [];
let observed = 0;
function collect() {
	if (typeof globalThis.__mal_collect_garbage === "function")
		globalThis.__mal_collect_garbage();
	if (typeof globalThis.gc === "function") globalThis.gc();
}
function collectionPath(record, flag) {
	if (flag !== flag) record.set(1, "dead");
	return record.get(2);
}
function mapReusePath(record, flag, observe) {
	const first = record.get(1);
	const second = record.get(2);
	observe(record);
	if (flag !== flag) {
		record.set(1, first);
		record.set(2, second);
	}
	return [first, second];
}
function invalidateEntries(record) {
	collect();
	if (record instanceof Map) record.clear();
}
function observe(value) {
	observed++;
	collect();
	return "seen:" + value;
}
function stableObserver(source, escape, sink) {
	const part = source.split("|")[1];
	if (escape !== escape) sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function stableOverwrite(source, escape, sink) {
	let part = source.split("|")[1];
	if (escape !== escape) part = sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function capturedObserver(source, escape, sink) {
	const part = /x(.*)z/.exec(source)[1];
	if (escape !== escape) sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
function capturedOverwrite(source, escape, sink) {
	let part = /x(.*)z/.exec(source)[1];
	if (escape !== escape) part = sink(part);
	return part.length + (part === "if" ? 10 : 0);
}
for (const text of ["if", "other", "", "𝄞", "\ud800x", "x".repeat(400)]) {
	const split = "prefix|" + text + "|tail";
	const capture = "x" + text + "z";
	rows.push(
		stableObserver(split, "string", observe),
		stableOverwrite(split, "string", observe),
		capturedObserver(capture, "string", observe),
		capturedOverwrite(capture, "string", observe),
	);
	for (const escape of [NaN, false, 1, null, undefined, {}, Symbol("s")])
		rows.push(
			stableObserver(split, escape, observe),
			stableOverwrite(split, escape, observe),
			capturedObserver(capture, escape, observe),
			capturedOverwrite(capture, escape, observe),
		);
}
for (const value of ["if", "other", 12, false, { length: 7 }, undefined]) {
	const source = {
		split(separator) {
			collect();
			rows.push(separator);
			return ["prefix", value];
		},
	};
	try {
		rows.push(stableObserver(source, "string", observe));
		rows.push(stableOverwrite(source, "string", observe));
		rows.push(stableOverwrite(source, NaN, observe));
	} catch (error) {
		rows.push(error.name);
	}
}
const source = {
	split() {
		return [
			0,
			Object.defineProperty({}, "length", {
				get() {
					collect();
					rows.push("length");
					return 11;
				},
			}),
		];
	},
};
rows.push(stableObserver(source, "string", observe));
try {
	stableOverwrite("p|if|t", NaN, () => {
		collect();
		throw new Error("observer");
	});
} catch (error) {
	rows.push(error.message);
}
try {
	capturedObserver("no-match", "string", observe);
} catch (error) {
	rows.push(error.name);
}
globalThis.collectionPath = collectionPath;
globalThis.mapReusePath = mapReusePath;
rows.push(collectionPath(new Map([[2, { label: "direct" }]]), "string"));
rows.push(
	mapReusePath(
		new Map([
			[1, { label: "first" }],
			[2, { label: "second" }],
		]),
		"string",
		invalidateEntries,
	),
);
const collectingMethods = {
	get set() {
		collect();
		rows.push("set-getter");
		return function (key, value) {
			collect();
			rows.push(["set-call", key, value, this === collectingMethods]);
			return this;
		};
	},
	get get() {
		collect();
		rows.push("get-getter");
		return function (key) {
			collect();
			return ["get-call", key, this === collectingMethods];
		};
	},
};
const throwingSetter = {
	get set() {
		collect();
		throw new Error("live-set");
	},
	get(key) {
		collect();
		return { key, label: "surviving-get" };
	},
};
for (const record of [
	new Map([[2, { label: "managed" }]]),
	collectingMethods,
	throwingSetter,
	Object.create(Map.prototype),
	new Proxy(new Map(), {}),
	null,
	undefined,
]) {
	for (const flag of ["string", NaN]) {
		try {
			rows.push(collectionPath(record, flag));
		} catch (error) {
			rows.push(error.name, error.message === "live-set");
		}
		try {
			rows.push(mapReusePath(record, flag, invalidateEntries));
		} catch (error) {
			rows.push(error.name, error.message === "live-set");
		}
	}
}
console.log(JSON.stringify([rows, observed]));
