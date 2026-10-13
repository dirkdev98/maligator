const gc = globalThis.__mal_collect_garbage;
function count(record) {
	return Object.keys(record).length;
}
const rows = [];
const record = { z: 1, a: 2, 9: 3 };
Object.defineProperty(record, "hidden", { value: 4 });
Object.defineProperty(record, "getter", {
	enumerable: true,
	get() {
		throw new Error("value read");
	},
});
record[Symbol("key")] = 5;
rows.push(count(record));
delete record.a;
rows.push(count(record));
record.newKey = 6;
Object.defineProperty(record, "z", { enumerable: false });
rows.push(count(record));
const dictionary = Object.create(null);
for (let i = 0; i < 100; i++) dictionary["key" + i] = i;
for (let i = 0; i < 70; i += 2) delete dictionary["key" + i];
rows.push(count(dictionary));
Object.setPrototypeOf(record, { inherited: true });
rows.push(count(record), count("a𝄞b"), count([1, , 3]), count(4), count(true));
for (const value of [null, undefined]) {
	try {
		count(value);
	} catch (error) {
		rows.push(error.name);
	}
}
rows.push([record, dictionary].map(count));
const events = [];
const proxy = new Proxy(
	{ a: 1, b: 2, c: 3 },
	{
		ownKeys(target) {
			events.push("keys");
			delete target.b;
			return ["c", "b", "a"];
		},
		getOwnPropertyDescriptor(target, key) {
			events.push(key);
			return Object.getOwnPropertyDescriptor(target, key);
		},
		get() {
			throw new Error("value read");
		},
	},
);
rows.push(count(proxy), events.join(","));
const broken = new Proxy(
	{},
	{
		ownKeys() {
			events.push("throw");
			throw new RangeError("keys");
		},
	},
);
try {
	count(broken);
} catch (error) {
	rows.push(error.name, events.at(-1));
}
function retained(record) {
	const keys = Object.keys(record);
	keys.push("extra");
	return [keys.length, keys[0]];
}
rows.push(retained({ first: 1 }));
let total = 0;
for (let i = 0; i < 500; i++) {
	if (i % 2) record.extra = i;
	else delete record.extra;
	total += count(record);
	if (typeof gc === "function") gc();
}
rows.push(total);
function traverse(record, observer) {
	const keys = Object.keys(record);
	let result = "";
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		result += key + ";";
		observer(record, key);
	}
	return result;
}
function snapshotReads(record, index) {
	const keys = Object.keys(record);
	const first = keys[index];
	return [first, keys.length, keys[0]];
}
const unchanged = () => {};
const small = { z: 1, a: 2, "𝄞": 3 };
Object.defineProperty(small, "hidden", { value: 4 });
small[Symbol("symbol")] = 5;
Object.defineProperty(small, "accessor", {
	enumerable: true,
	get() {
		throw new Error("snapshot read a value");
	},
});
rows.push(
	traverse(small, (object, key) => {
		if (key === "z") {
			delete object.a;
			object.added = 7;
			Object.defineProperty(object, "𝄞", { enumerable: false });
			if (typeof gc === "function") gc();
		}
	}),
);
rows.push(traverse({ 10: 1, 2: 2, b: 3, a: 4 }, unchanged));
rows.push(traverse(dictionary, unchanged), traverse("𝄞a", unchanged));
events.length = 0;
rows.push(traverse(proxy, unchanged), events.join(","));
rows.push(snapshotReads({ first: 1, second: 2 }, -0));
rows.push(snapshotReads({ first: 1 }, "0"));
rows.push(snapshotReads({ first: 1 }, -1));
let coercions = 0;
rows.push(
	snapshotReads(
		{ first: 1 },
		{
			toString() {
				coercions++;
				if (typeof gc === "function") gc();
				return "0";
			},
		},
	),
	coercions,
);
for (let i = 0; i < 24; i++) {
	const record = {};
	for (let k = 0; k < i; k++) record["key" + k] = k;
	rows.push(traverse(record, unchanged));
}
if (typeof process === "undefined" || process.env.MAL_PRIMORDIALS !== "locked") {
	Object.defineProperty(Array.prototype, "17", {
		configurable: true,
		get() {
			this[0] = "changed";
			this.length = 1;
			if (typeof gc === "function") gc();
			return "inherited";
		},
	});
	const inherited = snapshotReads({ first: 1, second: 2 }, 17);
	delete Array.prototype[17];
	rows.push(inherited);
	const original = Object.keys;
	let calls = 0;
	Object.keys = function (value) {
		calls++;
		return {
			get length() {
				calls += 10;
				return value.answer;
			},
		};
	};
	rows.push(count({ answer: 42 }), calls);
	Object.keys = () => ["override", "keys"];
	rows.push(traverse({}, unchanged));
	Object.keys = original;
}
console.log(JSON.stringify(rows));
