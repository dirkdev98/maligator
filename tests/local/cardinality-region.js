let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("cardinality-region failure: " + name);
	checks++;
}

function ordinary(seed) {
	const rows = [];
	let total = 0;
	for (let i = 0; i < 6; i++) {
		const row = { idx: i, value: "v" + (seed + i) };
		rows.push(row);
		total += row.idx + row.value.length;
	}
	return rows.length * 100 + total;
}

let ordinaryTotal = 0;
for (let i = 0; i < 2000; i++) ordinaryTotal += ordinary(i);
ok("ordinary virtual result", ordinary(10) === 633);
ok("ordinary repeated checksum", ordinaryTotal === 1283385);

const intrinsicPush = Array.prototype.push;

function indexed(seed) {
	const rows = [];
	for (let i = 0; i < 4; i++) rows.push({ idx: i, value: seed + i });
	return rows[(seed + 1) % 4].value;
}
let indexedTotal = 0;
for (let i = 0; i < 2000; i++) indexedTotal += indexed(i);
ok("indexed virtual field", indexed(10) === 13);
ok("indexed repeated checksum", indexedTotal === 2002000);

let indexCoercions = 0;
function objectIndex() {
	const rows = [];
	for (let i = 0; i < 4; i++) rows.push({ idx: i, value: 20 + i });
	const key = {
		toString() {
			indexCoercions++;
			return "2";
		},
	};
	return rows[key].value;
}
ok("object index deopt result", objectIndex() === 22);
ok("object index coerced once", indexCoercions === 1);

function mutateBeforeIndex() {
	const rows = [];
	for (let i = 0; i < 4; i++) rows.push({ idx: i, value: 30 + i });
	Array.prototype.push = function () {
		return -1;
	};
	return rows[1].value;
}
ok("protector deopt before indexed read", mutateBeforeIndex() === 31);
Array.prototype.push = intrinsicPush;

let midObservation = "";
function mutateAfterMethodLoad(i) {
	if (i === 2) {
		Array.prototype.push = function (row) {
			if (midObservation === "") {
				midObservation = this.length + ":" + this[0].idx + ":" + row.idx;
			}
			return intrinsicPush.call(this, row);
		};
	}
	return i + 10;
}
function mutateMidRegion() {
	const rows = [];
	let total = 0;
	for (let i = 0; i < 4; i++) {
		// Member lookup happens before argument evaluation. Mutation therefore lands
		// between the virtual `push` load and call and must deopt with prior history.
		rows.push({ idx: i, value: mutateAfterMethodLoad(i) });
		total += i;
	}
	return rows.length * 100 + total;
}
ok("mid-region result", mutateMidRegion() === 406);
ok("mid-region prior rows", midObservation === "3:0:3");
Array.prototype.push = intrinsicPush;

function postConstructionAliasDeopt() {
	const rows = [];
	for (let i = 0; i < 3; i++) rows.push({ idx: i, value: i });
	const alias = rows;
	Array.prototype.push = function () {
		return -1;
	};
	return alias[2].value;
}
ok(
	"materialization publishes post-construction alias",
	postConstructionAliasDeopt() === 2,
);
Array.prototype.push = intrinsicPush;

let overrideObservation = "";
let overrideCaptured = null;
Array.prototype.push = function (row) {
	overrideObservation = this.length + ":" + row.idx;
	row.value += 10;
	overrideCaptured = row;
	return intrinsicPush.call(this, row);
};
function overriddenBeforeEntry() {
	const rows = [];
	let result = 0;
	let total = 0;
	let identities = 0;
	for (let i = 0; i < 3; i++) {
		const row = { idx: i, value: i + 1 };
		result += rows.push(row);
		total += row.value;
		if (row === overrideCaptured) identities++;
	}
	return rows.length * 100 + result + total + identities;
}
ok("override return and receiver", overriddenBeforeEntry() === 345);
ok("override mutates exact row", overrideObservation === "2:2");
Array.prototype.push = intrinsicPush;

const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push");
let getterObservations = "";
Object.defineProperty(Array.prototype, "push", {
	configurable: true,
	get() {
		getterObservations += this.length;
		return intrinsicPush;
	},
});
function accessorBeforeEntry() {
	const rows = [];
	for (let i = 0; i < 3; i++) {
		const row = { idx: i, value: i };
		rows.push(row);
	}
	return rows.length;
}
ok("accessor result", accessorBeforeEntry() === 3);
ok("accessor receiver and calls", getterObservations === "012");
Object.defineProperty(Array.prototype, "push", pushDescriptor);

ok("check count", checks === 14);
console.log("cardinality-region PASS " + checks + "/" + checks);
