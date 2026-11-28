// Loads that miss a site's own row: computed keys cycling through records, which the
// shared stub answers and a site adopts on a repeat, named loads over many shapes, and
// keyed reads of arrays by index strings, names and integers. Each phase changes the
// records, their shapes or the Array prototype after the sites have warmed, so a
// stale row or stub entry would show up as a wrong value.
const log = [];

function record(label, read) {
	try {
		log.push(`${label}: ${JSON.stringify(read())}`);
	} catch (error) {
		log.push(`${label}: ${error.constructor.name}`);
	}
}

function churn() {
	const garbage = [];
	for (let i = 0; i < 300; i++) garbage.push({ i, text: `item-${i}` });
	globalThis.gc?.();
	return garbage.length;
}

function read(object, key) {
	return object[key];
}

function readAlpha(object) {
	return object.alpha;
}

function cycle(objects, keys, rounds) {
	const values = [];
	for (let round = 0; round < rounds; round++) {
		for (const object of objects) {
			for (const key of keys) values.push(read(object, key));
		}
	}
	return values.join(",");
}

const base = { inherited: "from prototype" };
const records = [
	{ a: 1, b: 2, c: 3 },
	{ c: 30, b: 20, a: 10 },
	Object.assign(Object.create(base), { a: 100, b: 200, c: 300 }),
];
const keys = ["a", "b", "c", "inherited", "missing"];

record("cycle warm", () => cycle(records, keys, 4));
record("repeat key", () => cycle(records, ["b", "b", "b"], 3));
records[0].d = 4;
record("after add", () => cycle(records, [...keys, "d"], 2));
delete records[1].b;
record("after delete", () => cycle(records, keys, 2));
Object.defineProperty(records[2], "a", {
	get() {
		return "getter a";
	},
	configurable: true,
});
record("after getter", () => cycle(records, keys, 2));
Object.setPrototypeOf(records[0], { missing: "now present" });
record("after reparent", () => cycle(records, keys, 2));
churn();
record("after churn", () => cycle(records, keys, 2));

const shapes = [
	{ alpha: 1 },
	{ beta: 0, alpha: 2 },
	{ gamma: 0, beta: 0, alpha: 3 },
	{ delta: 0, alpha: 4 },
	{ alpha: 5, epsilon: 0 },
	{ zeta: 0, alpha: 6 },
	{ eta: 0, theta: 0, alpha: 7 },
	Object.create({ alpha: "inherited alpha" }),
	{
		get alpha() {
			return "getter alpha";
		},
	},
	{},
];
const dictionary = { alpha: "dictionary", spare: 0 };
delete dictionary.spare;
shapes.push(dictionary);

function named(rounds) {
	const values = [];
	for (let round = 0; round < rounds; round++) {
		for (const shape of shapes) values.push(readAlpha(shape));
	}
	return values.join(",");
}

record("named warm", () => named(4));
shapes[3].alpha = "rewritten";
dictionary.alpha = "dictionary rewritten";
record("named after writes", () => named(2));
delete shapes[0].alpha;
record("named after delete", () => named(2));
record("named primitive", () => [readAlpha("text"), readAlpha(7)].join(","));
record("named nullish", () => readAlpha(null));

const dense = ["zero", "one", "two", "three"];
const holey = ["zero", , "two"];
dense.label = "own name";
const arrayKeys = [
	"0",
	"2",
	"3",
	"5",
	"01",
	"-0",
	"1.0",
	"4294967295",
	"length",
	"label",
	"push",
];
const integerKeys = [0, 1, 2, 3, 5, -1, 1.5, 2 ** 32];

function arrayReads(array) {
	const values = [];
	for (const key of arrayKeys) values.push(String(read(array, key)).slice(0, 12));
	for (const key of integerKeys) values.push(String(read(array, key)).slice(0, 12));
	return values.join(",");
}

for (let round = 0; round < 3; round++) {
	record(`dense ${round}`, () => arrayReads(dense));
	record(`holey ${round}`, () => arrayReads(holey));
}
record("fresh index string", () => read(dense, String(1 + 1)));
record("fresh name", () => read(dense, ["la", "bel"].join("")));
Array.prototype[1] = "prototype one";
record("holey with prototype element", () => arrayReads(holey));
record("dense with prototype element", () => arrayReads(dense));
delete Array.prototype[1];
record("holey after prototype delete", () => arrayReads(holey));
churn();
record("array after churn", () => arrayReads(dense));

console.log(log.join("\n"));
