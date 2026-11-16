const originalObject = Object;
const originalEntries = Object.entries;
const scenario = process.env.ENTRIES_PROJECT_CASE ?? "loop";
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const events = [];
let saved;
function collect() {
	if (typeof gc === "function") gc();
}
function project(record, index) {
	return Object.entries(record)[index];
}
function first(record) {
	return Object.entries(record)[0];
}
function missing(record) {
	return Object.entries(record)[99];
}
function prepared(record, index, prepare) {
	return Object.entries(prepare(record))[index];
}
function loop() {
	let total = 0;
	for (let i = 0; i < 24; i++) {
		const held = { label: "held-" + i };
		const record = { first: i, second: held, third: 3, fourth: 4 };
		const pair = project(record, i & 1);
		collect();
		total += record.first + pair[0].length;
		if (typeof pair[1] === "object") total += pair[1] === held ? 1 : -1000;
		else total += pair[1];
	}
	return total;
}
function observed() {
	const record = { first: 7, second: { label: "kept" }, third: 3, fourth: 4 };
	const pair = project(record, 0);
	collect();
	return [pair, record.first, saved === record];
}
let result;
try {
	if (scenario === "loop") result = loop();
	else if (scenario === "literal") result = first({ a: { label: "value" }, b: 2 });
	else if (scenario === "missing") result = missing({ a: 1, b: 2 });
	else if (scenario === "indices")
		result = [-0, 1, "0", -1, 0.5, NaN, Infinity].map((index) =>
			project({ a: 1, b: { label: "value" } }, index),
		);
	else if (scenario === "coercion") {
		const record = {
			get first() {
				events.push("first");
				collect();
				return { label: "captured" };
			},
			second: 2,
		};
		const key = {
			[Symbol.toPrimitive]() {
				events.push("key");
				record.second = 99;
				collect();
				return "1";
			},
		};
		result = [project(record, key), record.second];
	} else if (scenario === "delete") {
		const record = {
			get first() {
				events.push("first");
				delete this.second;
				collect();
				return 7;
			},
			second: 2,
			third: { label: "third" },
		};
		result = project(record, 1);
	} else if (scenario === "large") {
		const record = {};
		for (let i = 0; i < 24; i++) record["field" + i] = { value: i };
		result = project(record, 23);
	} else if (scenario === "getter-rebind") {
		const record = {
			get first() {
				events.push("first");
				Object.entries = () => ({ 0: "later" });
				collect();
				return 7;
			},
			second: 2,
		};
		result = [project(record, 0), project(record, 0)];
	} else if (scenario === "argument-rebind") {
		result = prepared({ first: 7, second: 2 }, 0, (record) => {
			Object.entries = () => ({ 0: "later" });
			events.push("argument");
			collect();
			return record;
		});
	} else if (scenario === "argument-throw") {
		const token = { label: "argument stopped" };
		try {
			prepared({}, 0, () => {
				events.push("argument");
				collect();
				throw token;
			});
		} catch (error) {
			result = error === token;
		}
	} else if (scenario === "getter-throw") {
		const token = { label: "getter stopped" };
		try {
			project(
				{
					get first() {
						events.push("first");
						collect();
						throw token;
					},
				},
				0,
			);
		} catch (error) {
			result = error === token;
		}
	} else if (
		scenario === "method" ||
		scenario === "global" ||
		scenario === "read-throw"
	) {
		const replacement = function (record) {
			saved = record;
			return new Proxy(
				{},
				{
					get(_target, key) {
						events.push("read:" + key);
						record.first += 10;
						collect();
						if (scenario === "read-throw") throw { label: "read stopped" };
						return ["first", record.first];
					},
				},
			);
		};
		if (scenario === "global") globalThis.Object = { entries: replacement };
		else Object.entries = replacement;
		try {
			result = observed();
		} catch (error) {
			result = [error.label, saved.first];
		}
	} else if (scenario === "lexical") {
		function shadowed(Object, record, index) {
			return Object.entries(record)[index];
		}
		result = shadowed({ entries: () => ({ 0: { label: "shadowed" } }) }, {}, 0);
	} else throw new Error("Unknown entries projection scenario");
} finally {
	globalThis.Object = originalObject;
	Object.entries = originalEntries;
}
console.log(JSON.stringify({ result, events }));
