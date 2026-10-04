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
for (let round = 0; round < 64; round++) {
	const key = keys[round & 3];
	for (const row of rows) row[key] = round;
}

const results = [];
results.push(["constant key checksum", checksum === 16 * (4 * 130816 + 512 * 6)]);
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

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
