const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const rows = [];
function survivingValueCount(record, flag, observe) {
	let values = Object.values(record);
	if (flag !== flag) values = observe(values);
	observe(record);
	return values.length;
}
function survivingValueIndex(record, flag, index, observe) {
	const values = Object.values(record);
	if (flag !== flag) observe(values);
	observe(record);
	return [values.length, values[index]];
}
function inspect(record, index, observe) {
	const values = Object.values(record);
	observe(record);
	const value = values[index];
	return [value, values.length, values[0]];
}
function count(record, observe) {
	const values = Object.values(record);
	observe(record);
	return values.length;
}
function traverse(record, observe) {
	const values = Object.values(record);
	let text = "";
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		observe(record, index);
		text +=
			(value && typeof value === "object"
				? value.label
				: Object.is(value, -0)
					? "-0"
					: String(value)) + ";";
	}
	return text;
}
const unchanged = () => {};
for (let i = 0; i < 16; i++) {
	const record = {
		first: { label: "old-" + i },
		second: { label: "second-" + i },
		third: i + 0.5,
		fourth: { label: "fourth-" + i },
	};
	rows.push(
		traverse(record, (target, index) => {
			if (index === 0) {
				target.first = { label: "new" };
				target.second = "replaced";
				delete target.third;
				delete target.fourth;
				target.extra = 77;
				if (typeof gc === "function") gc();
			}
		}),
	);
}
[-0, 1, "0", -1, 17].forEach(function valuesSnapshotIndex(index) {
	const values = Object.values({ first: { label: "held" }, second: "second" });
	if (typeof gc === "function") gc();
	const value = values[index];
	rows.push([value, values.length, values[0]]);
});
rows.push(
	count({ first: { label: "held-count" }, second: 2 }, (target) => {
		delete target.first;
		if (typeof gc === "function") gc();
	}),
);
const specials = {
	negative: -0,
	nan: NaN,
	infinite: Infinity,
	nil: null,
	missing: undefined,
	boolean: true,
};
Object.defineProperty(specials, "hidden", {
	get() {
		throw new Error("hidden read");
	},
});
Object.defineProperty(specials, Symbol("symbol"), {
	enumerable: true,
	get() {
		throw new Error("symbol read");
	},
});
rows.push(traverse(specials, unchanged));
rows.push(traverse({ 10: "ten", 2: "two", z: "z", a: "a" }, unchanged));
const large = {};
for (let i = 0; i < 20; i++) large["field" + i] = i;
rows.push(traverse(large, unchanged), traverse("a𝌆b", unchanged));
const boundary = {
	a: 0,
	b: 1,
	c: 2,
	d: 3,
	e: 4,
	f: 5,
	g: 6,
	h: 7,
	i: 8,
	j: 9,
	k: 10,
	l: 11,
	m: 12,
	n: 13,
	o: 14,
	p: 15,
};
rows.push(inspect(boundary, 15, unchanged), count(boundary, unchanged));
const events = [];
const accessors = { first: 1 };
Object.defineProperty(accessors, "second", {
	enumerable: true,
	get() {
		events.push("get");
		delete accessors.third;
		if (typeof gc === "function") gc();
		return 2;
	},
});
accessors.third = 3;
rows.push(count(accessors, unchanged), events.join(","));
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
rows.push(traverse(proxy, unchanged), events.join(","));
let conversions = 0;
rows.push(
	inspect(
		{ first: 42 },
		{
			toString() {
				conversions++;
				if (typeof gc === "function") gc();
				return "0";
			},
		},
		unchanged,
	),
	conversions,
);
for (const target of [null, undefined]) {
	try {
		count(target, unchanged);
	} catch (error) {
		rows.push(error.name);
	}
}
const throwing = {
	first: 1,
	get second() {
		events.push("throw");
		throw new RangeError("values");
	},
};
try {
	count(throwing, unchanged);
} catch (error) {
	rows.push(error.name, events.at(-1));
}
if (typeof process === "undefined" || process.env.MAL_PRIMORDIALS !== "locked") {
	let inheritedReads = 0;
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		get() {
			inheritedReads++;
			return "wrong";
		},
	});
	const ownUndefined = inspect({ first: 1, second: undefined }, 1, unchanged);
	delete Array.prototype[1];
	rows.push(ownUndefined, inheritedReads);
	Object.defineProperty(Array.prototype, "17", {
		configurable: true,
		get() {
			this[0] = "changed";
			this.length = 1;
			if (typeof gc === "function") gc();
			return "inherited";
		},
	});
	rows.push(inspect({ first: 1, second: 2 }, 17, unchanged));
	delete Array.prototype[17];
	const original = Object.values;
	let calls = 0;
	Object.values = (record) => {
		calls++;
		return [record.answer, "override"];
	};
	rows.push(inspect({ answer: 99 }, 0, unchanged), calls);
	Object.values = original;
	const namespace = {
		get values() {
			calls++;
			return original;
		},
	};
	function captured(target, prepare) {
		const values = namespace.values(prepare(target));
		return [values[0], values.length];
	}
	rows.push(
		captured({ first: 7 }, (target) => {
			Object.defineProperty(namespace, "values", {
				value: () => ["late"],
				configurable: true,
			});
			return target;
		}),
		calls,
	);
}
function collectingSnapshotObserver(value) {
	if (typeof gc === "function") gc();
	if (Array.isArray(value)) value[0] = "observed";
	else if (value && typeof value === "object") {
		value.changed = "late";
		delete value.first;
	}
	return ["replacement"];
}
rows.push(
	survivingValueCount({ first: "direct" }, "string", collectingSnapshotObserver),
	survivingValueCount({ first: "direct" }, NaN, collectingSnapshotObserver),
	survivingValueIndex({ first: "direct" }, "string", 0, collectingSnapshotObserver),
	survivingValueIndex({ first: "direct" }, NaN, 0, collectingSnapshotObserver),
);
for (const record of [
	{ first: { label: "surviving" }, second: undefined },
	boundary,
	large,
	accessors,
	proxy,
	"ab𝄞",
	null,
	undefined,
]) {
	try {
		rows.push(survivingValueCount(record, "string", collectingSnapshotObserver));
		rows.push(survivingValueCount(record, NaN, collectingSnapshotObserver));
		for (const index of [
			0,
			"0",
			17,
			Symbol("missing"),
			{
				toString() {
					events.push("snapshot-key");
					if (typeof gc === "function") gc();
					return "0";
				},
			},
		]) {
			rows.push(survivingValueIndex(record, "string", index, collectingSnapshotObserver));
			rows.push(survivingValueIndex(record, NaN, index, collectingSnapshotObserver));
		}
	} catch (error) {
		rows.push(error.name);
	}
}
try {
	survivingValueCount({ first: 1 }, NaN, () => {
		if (typeof gc === "function") gc();
		throw new Error("snapshot observer");
	});
} catch (error) {
	rows.push(error.message);
}
console.log(JSON.stringify(rows));
