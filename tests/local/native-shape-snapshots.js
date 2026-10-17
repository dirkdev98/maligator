"use strict";

function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(message + ": " + String(actual) + " !== " + String(expected));
	}
}

class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
}

function sumFields(points) {
	let total = 0;
	for (let index = 0; index < points.length; index++)
		total += points[index].x * 3 + points[index].y;
	return total;
}

function translate(points, dx, dy) {
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		point.x += dx;
		point.y += dy;
	}
}

function storeLabels(records, label) {
	for (let index = 0; index < records.length; index++)
		records[index].label = label + index;
}

const points = [];
for (let index = 0; index < 200; index++)
	points.push(new Point(index * 0.5, index + 1.25));
expectValue(sumFields(points), 50000, "monomorphic tagged fields");
translate(points, 0.25, -0.5);
expectValue(points[3].x, 1.75, "tagged write-back keeps fractions");
expectValue(points[4].y, 4.75, "tagged write-back second field");
translate(points, -0.25, 0);
expectValue(points[2].x, 1, "tagged write-back canonical integer");
points[7].y = -0;
translate(points, -0, -0);
expectValue(points[7].y, -0, "tagged write-back keeps negative zero");
points[9].x = NaN;
translate(points, 1, 1);
expectValue(points[9].x, NaN, "tagged write-back keeps NaN");

// Compact literals start with typed fields; a later loop iteration widens one of them.
const literals = [];
for (let index = 0; index < 100; index++) literals.push({ x: index, y: index * 2 });
literals[50].x = "widened";
let widened = "";
let numeric = 0;
for (let index = 0; index < literals.length; index++) {
	const value = literals[index].x;
	if (typeof value === "string") widened += value;
	else numeric += value + literals[index].y;
}
expectValue(widened, "widened", "a widened layout misses the earlier snapshot");
expectValue(numeric, 3 * (4950 - 50), "other layouts keep their snapshot");

// Shapes change inside the loop that holds the snapshot.
const changing = [];
for (let index = 0; index < 60; index++) changing.push({ x: index, y: 1 });
let observed = 0;
for (let index = 0; index < changing.length; index++) {
	const record = changing[index];
	if (index === 10) record.extra = 5;
	if (index === 20) delete record.y;
	if (index === 30) Object.defineProperty(record, "x", { get: () => 1000 });
	if (index === 40) Object.freeze(record);
	observed += record.x + (record.y ?? 100);
	try {
		record.x = record.x + 1;
	} catch (error) {
		observed += error instanceof TypeError ? 7 : -1_000_000;
	}
}
expectValue(
	observed,
	1770 - 30 + 1000 + 59 + 100 + 7 + 7,
	"mid-loop add, delete, accessor, and freeze",
);
expectValue(changing[11].x, 12, "store after an added property");
expectValue(changing[40].x, 40, "frozen record is unchanged");

// Different classes alternate at one site, so the snapshot keeps being replaced.
class Other {
	constructor(y, x) {
		this.y = y;
		this.x = x;
	}
}
const mixed = [];
for (let index = 0; index < 90; index++)
	mixed.push(index % 3 === 0 ? new Other(index, -index) : new Point(index, index));
expectValue(sumFields(mixed), 4 * 2700 - 2 * 1305, "alternating shapes");
translate(mixed, 1, 2);
expectValue(sumFields(mixed), 4 * 2700 - 2 * 1305 + 90 * 5, "alternating write-back");

// A prototype written through a snapshot must still notify inherited readers.
const prototype = { x: 1, y: 2 };
const heirs = [Object.create(prototype), Object.create(prototype)];
let inherited = 0;
const owners = [prototype, { x: 0, y: 0 }];
for (let round = 0; round < 50; round++) {
	for (let index = 0; index < owners.length; index++) owners[index].x = round;
	for (let index = 0; index < heirs.length; index++) inherited += heirs[index].x;
}
expectValue(inherited, 2450, "prototype stores invalidate inherited reads");

const labelled = [];
for (let index = 0; index < 40; index++) labelled.push({ label: "", rank: index });
storeLabels(labelled, "item-");
expectValue(labelled[39].label, "item-39", "tagged reference store");
Object.defineProperty(labelled[20], "label", { writable: false });
try {
	storeLabels(labelled, "next-");
	throw new Error("non-writable store did not throw");
} catch (error) {
	expectValue(error instanceof TypeError, true, "non-writable store throws");
}
expectValue(labelled[19].label, "next-19", "stores before the read-only record apply");
expectValue(labelled[20].label, "item-20", "read-only record keeps its value");

console.log("native-shape-snapshots PASS");
