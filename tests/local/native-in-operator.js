"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
	}
}

function has(key, object) {
	return key in object;
}

const hidden = Symbol("hidden");
const parent = { inherited: 1 };
const record = Object.create(parent);
record.own = 1;
record[hidden] = 2;
Object.defineProperty(record, "quiet", { value: 3, enumerable: false });
const keyObject = {
	toString() {
		return "own";
	},
};

for (let round = 0; round < 3; round++) {
	expectValue(has("own", record), true, "an own key");
	expectValue(has(["o", "wn"].join(""), record), true, "an own key built at runtime");
	expectValue(has("quiet", record), true, "a non-enumerable own key");
	expectValue(has("inherited", record), true, "an inherited key");
	expectValue(has("absent", record), false, "an absent key");
	expectValue(has(hidden, record), true, "an own symbol");
	expectValue(has(Symbol("hidden"), record), false, "a different symbol");
	expectValue(has(keyObject, record), true, "an object key converts through toString");
}

const wide = {};
for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
let found = 0;
for (let i = 0; i < 40; i++) if (has(`k${i}`, wide)) found++;
expectValue(found, 20, "a wide object");

delete record.own;
expectValue(has("own", record), false, "a deleted key");
parent.own = 0;
expectValue(has("own", record), true, "a key now inherited");

const trapped = new Proxy(
	{},
	{
		has(target, key) {
			return key === "virtual";
		},
	},
);
expectValue(has("virtual", trapped), true, "a proxy trap answers");
expectValue(has("own", trapped), false, "a proxy trap denies");

let threw = false;
try {
	has("own", "not an object");
} catch (error) {
	threw = error instanceof TypeError;
}
expectValue(threw, true, "a primitive right-hand side throws");

console.log("native-in-operator PASS");
