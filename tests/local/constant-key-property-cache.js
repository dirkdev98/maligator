"use strict";

// Literal keys reach computed loads and stores through arrays and variables.
// Each round's key is fixed, so the site's cache must keep serving it after the
// first fill.
const rows = Array.from({ length: 512 }, (_, index) => ({
	field0: index,
	field1: index + 1,
	field2: index + 2,
	field3: index + 3,
}));
const keys = ["field0", "field1", "field2", "field3"];
let checksum = 0;
for (let round = 0; round < 64; round++) {
	const key = keys[round & 3];
	for (const row of rows) checksum += row[key];
}
let freshChecksum = 0;
let freshExpected = 0;
for (let round = 0; round < 16; round++) {
	for (const row of rows) {
		const key = "field" + String(round & 3);
		freshChecksum += row[key];
		freshExpected += row.field0 + (round & 3);
	}
}
for (let round = 0; round < 64; round++) {
	const key = keys[round & 3];
	for (const row of rows) row[key] = round;
}

const results = [];
results.push(["constant key checksum", checksum === 16 * (4 * 130816 + 512 * 6)]);
results.push([
	"reconstructed names read the selected field",
	freshChecksum === freshExpected,
]);
results.push([
	"constant key stores",
	rows.every(
		(row) =>
			row.field0 === 60 && row.field1 === 61 && row.field2 === 62 && row.field3 === 63,
	),
]);
const frozen = Object.freeze({ field0: "frozen" });
let frozenThrew = false;
try {
	frozen[keys[0]] = "changed";
} catch {
	frozenThrew = true;
}
results.push([
	"frozen store through constant",
	frozenThrew && frozen.field0 === "frozen",
]);
const added = {};
added[keys[2]] = "fresh";
results.push([
	"fresh property through constant",
	added.field2 === "fresh" && Object.keys(added).length === 1,
]);
const mixed = { length: 3, field0: "own" };
results.push(["mixed receivers", mixed[keys[0]] === "own" && rows[1][keys[3]] === 63]);
results.push(["array length through constant", [1, 2, 3][["length"][0]] === 3]);
const inherited = Object.create({ field1: "inherited" });
results.push(["inherited constant key", inherited[keys[1]] === "inherited"]);
inherited.field1 = "own";
results.push(["shadowing after inherited hit", inherited[keys[1]] === "own"]);

function readCreatedKey(record, suffix) {
	return record["field" + suffix];
}
const changed = { field0: 7 };
readCreatedKey(changed, "0");
readCreatedKey(changed, "0");
let getterCalls = 0;
Object.defineProperty(changed, "field0", {
	get() {
		getterCalls++;
		return 9;
	},
});
results.push([
	"a reconstructed name observes an accessor replacing a cached data field",
	readCreatedKey(changed, "0") === 9 &&
		readCreatedKey(changed, "0") === 9 &&
		getterCalls === 2,
]);
let proxyCalls = 0;
const proxied = new Proxy(
	{ field0: 3 },
	{
		get(target, key) {
			proxyCalls++;
			return target[key] + 1;
		},
	},
);
results.push([
	"a reconstructed name still invokes proxy traps",
	readCreatedKey(proxied, "0") === 4 && proxyCalls === 1,
]);

const longNames = { sharedPropertyPrefixFirst: 1, sharedPropertyPrefixOther: 2 };
const longSuffixes = ["First", "Other"];
let longChecksum = 0;
for (let i = 0; i < longSuffixes.length * 8; i++) {
	longChecksum += longNames["sharedPropertyPrefix" + longSuffixes[i & 1]];
}
results.push([
	"long names keep distinct suffixes",
	longChecksum === longSuffixes.length * 12,
]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
