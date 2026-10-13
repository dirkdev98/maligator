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
if (typeof process === "undefined" || process.env.MAL_PRIMORDIALS !== "locked") {
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
	Object.keys = original;
}
console.log(JSON.stringify(rows));
