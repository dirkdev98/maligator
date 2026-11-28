"use strict";

// Monomorphic static store hits of every value class into old owners while
// incremental major cycles run. A missing card frees a young value that only an old
// owner references. A missing SATB record frees an old value that moves out of an
// untraced owner into an already traced one before its field is overwritten with a
// Number.
function Slot(id) {
	this.id = id;
	this.count = 0;
	this.num = 0;
	this.flag = false;
	this.neg = 0;
	this.nan = 0;
	this.ref = null;
	this.text = "";
	this.spare = null;
}

const SLOTS = 16384;
const HALF = SLOTS / 2;
const ROUNDS = 12;
const slots = [];
for (let i = 0; i < SLOTS; i++) slots.push(new Slot(i));

// `| 0` gives the stored values known kinds, so Numbers and Booleans take the
// non-reference store.
function storeValues(slot, index, round) {
	const i = index | 0;
	const r = round | 0;
	slot.count = (i + r) | 0;
	slot.num = i + r * 0.25;
	slot.flag = ((i + r) & 1) === 0;
	slot.neg = -(i & 0);
	slot.nan = (i - i) / (i - i);
	slot.ref = { id: i, round: r };
	slot.text = "t" + i + ":" + r;
}

function moveReference(from, to, round) {
	to.spare = from.ref;
	from.ref = round | 0;
}

function check(slot, i, round, failures) {
	const fail = (what) => {
		if (failures.length < 8) failures.push(`slot ${i} round ${round}: ${what}`);
	};
	if (slot.count !== ((i + round) | 0)) fail(`count ${slot.count}`);
	if (slot.num !== i + round * 0.25) fail(`num ${slot.num}`);
	if (slot.flag !== (((i + round) & 1) === 0)) fail(`flag ${slot.flag}`);
	if (!Object.is(slot.neg, -0)) fail(`neg ${slot.neg}`);
	if (!Number.isNaN(slot.nan)) fail(`nan ${slot.nan}`);
	if (slot.ref !== round) fail(`ref ${slot.ref}`);
	if (slot.text !== "t" + i + ":" + round) fail(`text ${slot.text}`);
	const moved = slot.spare;
	const source = (i + HALF) % SLOTS;
	if (moved === null || moved.id !== source || moved.round !== round)
		fail(`spare ${moved === null ? "null" : `${moved.id}/${moved.round}`}`);
}

const failures = [];
for (let round = 0; round < ROUNDS; round++) {
	for (let i = 0; i < SLOTS; i++) storeValues(slots[i], i, round);
	// Allocation between the moves lets collection steps interleave with them; pairing
	// owners half the array apart makes it likely that one is traced and not the other.
	const garbage = [];
	for (let i = 0; i < SLOTS; i++) {
		moveReference(slots[i], slots[(i + HALF) % SLOTS], round);
		garbage.push({ i, s: "g" + i });
	}
	for (let i = 0; i < SLOTS; i++) check(slots[i], i, round, failures);
}

if (failures.length === 0) console.log("static-store-hit-barriers PASS");
else for (const failure of failures) console.log(failure);
