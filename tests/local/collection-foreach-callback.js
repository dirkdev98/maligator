"use strict";
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const kind = process.env.COLLECTION_CALLBACK_KIND ?? "map";
const output = [];
function check(condition, message) {
	if (!condition) throw new Error(message);
}
function visitMap() {
	const key = { name: "key" };
	const values = new Map([
		[key, { name: "value" }],
		["b", 2n],
		["c", "three"],
	]);
	const context = { name: "context" };
	let changed = false;
	let defaults = 0;
	const seen = [];
	values.forEach(
		function mapVisit(value, current, owner, missing = ++defaults) {
			check(this === context && owner === values && arguments.length === 3, "map ABI");
			seen.push([typeof value, current === key ? "key" : current, missing]);
			if (!changed) {
				changed = true;
				check(value.name === "value" && current === key, "map key/value order");
				owner.delete("b");
				owner.delete(key);
				owner.set(key, 4n);
				owner.set("d", "last");
				const inner = new Map([["inner", 9]]);
				inner.forEach(function nestedMap(v, k, m) {
					check(v === 9 && k === "inner" && m === inner, "nested map");
					collect();
				});
			}
			collect();
		},
		context,
		"ignored",
	);
	check(defaults === 4, "map defaults");
	output.push(seen);
	const cleared = new Map([
		[1, "one"],
		[2, "two"],
	]);
	cleared.forEach(function clearMap(v, k, m) {
		output.push(v);
		if (k === 1) {
			m.clear();
			m.set(3, "three");
		}
	});
	const primitive = new Map([[1, 1]]);
	primitive.forEach(function strictMap() {
		"use strict";
		check(this === 7, "strict this");
	}, 7);
	let calls = 0;
	try {
		const throwing = new Map([["throw", key]]);
		throwing.forEach(function throwMap() {
			calls++;
			throw key;
		});
	} catch (error) {
		check(error === key, "map throw identity");
	}
	check(calls === 1, "map no replay");
	values.forEach(function afterMap() {
		calls++;
	});
	check(calls === 4, "map resume context");
	const replaced = new Map();
	Object.defineProperty(replaced, "forEach", {
		value(callback, receiver) {
			callback.call(receiver, "own", "key", this);
		},
	});
	replaced.forEach(function ownMap(v, k, m) {
		check(v === "own" && k === "key" && m === replaced, "own map method");
	});
	const wrong = new Map();
	Object.defineProperty(wrong, "forEach", { value: Set.prototype.forEach });
	try {
		wrong.forEach(function wrongMap() {
			throw new Error("called");
		});
		throw new Error("no brand error");
	} catch (error) {
		check(error instanceof TypeError, "map wrong brand");
	}
}
function visitSet() {
	const value = { name: "value" };
	const values = new Set([value, 2n, "three"]);
	const context = { name: "context" };
	let changed = false;
	let defaults = 0;
	const seen = [];
	values.forEach(
		function setVisit(current, duplicate, owner, missing = ++defaults) {
			check(
				this === context &&
					owner === values &&
					arguments.length === 3 &&
					current === duplicate,
				"set ABI",
			);
			seen.push([typeof current, current === value ? "value" : String(current), missing]);
			if (!changed) {
				changed = true;
				owner.delete(2n);
				owner.delete(value);
				owner.add(value);
				owner.add("last");
				const inner = new Set([9]);
				inner.forEach(function nestedSet(v, k, s) {
					check(v === 9 && k === 9 && s === inner, "nested set");
					collect();
				});
			}
			collect();
		},
		context,
		"ignored",
	);
	check(defaults === 4, "set defaults");
	output.push(seen);
	const cleared = new Set([1, 2]);
	cleared.forEach(function clearSet(v, k, s) {
		output.push(v);
		if (v === 1) {
			s.clear();
			s.add(3);
		}
	});
	const primitive = new Set([1]);
	primitive.forEach(function strictSet() {
		"use strict";
		check(this === 7, "strict this");
	}, 7);
	let calls = 0;
	try {
		const throwing = new Set([value]);
		throwing.forEach(function throwSet() {
			calls++;
			throw value;
		});
	} catch (error) {
		check(error === value, "set throw identity");
	}
	check(calls === 1, "set no replay");
	values.forEach(function afterSet() {
		calls++;
	});
	check(calls === 4, "set resume context");
	const replaced = new Set();
	Object.defineProperty(replaced, "forEach", {
		value(callback) {
			callback("own", "own", this);
		},
	});
	replaced.forEach(function ownSet(v, k, s) {
		check(v === "own" && k === v && s === replaced, "own set method");
	});
	const wrong = new Set();
	Object.defineProperty(wrong, "forEach", { value: Map.prototype.forEach });
	try {
		wrong.forEach(function wrongSet() {
			throw new Error("called");
		});
		throw new Error("no brand error");
	} catch (error) {
		check(error instanceof TypeError, "set wrong brand");
	}
}
function replacedConstructor() {
	const OriginalMap = Map,
		OriginalSet = Set;
	try {
		globalThis.Map = function () {
			return {
				forEach(callback) {
					callback("custom", "key", this);
					return 73;
				},
			};
		};
		const custom = new Map();
		const result = custom.forEach(function customMap(v, k, m) {
			check(v === "custom" && k === "key" && m === custom, "replaced constructor");
		});
		check(result === 73, "replaced constructor result");
		globalThis.Set = function () {
			return new OriginalMap([["key", "value"]]);
		};
		const other = new Set();
		other.forEach(function otherSet(v, k, m) {
			check(v === "value" && k === "key" && m === other, "other collection");
		});
		globalThis.Map = function () {
			return { forEach: OriginalMap.prototype.forEach };
		};
		const invalid = new Map();
		try {
			invalid.forEach(function invalidMap() {
				throw new Error("called");
			});
			throw new Error("no brand error");
		} catch (error) {
			check(error instanceof TypeError, "borrowed brand");
		}
	} finally {
		globalThis.Map = OriginalMap;
		globalThis.Set = OriginalSet;
	}
}
if (kind === "map") visitMap();
else visitSet();
if (process.env.COLLECTION_MUTABLE === "1") replacedConstructor();
console.log(JSON.stringify(output));
