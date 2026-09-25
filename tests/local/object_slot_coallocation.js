const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("object-slot-coallocation requires MAL_HOST_GC=1");
}

let passed = 0;
function check(label, condition) {
	if (!condition) throw new Error(label);
	passed++;
}

const retained = [];
for (let i = 0; i < 2000; i++) retained.push({ value: "value:" + i });
check("retained value", retained[1999].value === "value:1999");

class AssignedRecord {
	constructor(value) {
		this.a = value;
		this.b = value + 1;
		this.c = value + 2;
		this.d = value + 3;
		this.e = value + 4;
		this.f = value + 5;
		this.g = value + 6;
		this.h = value + 7;
	}
}
let assignedRecord;
for (let i = 0; i < 64; i++) assignedRecord = new AssignedRecord(10);
check(
	"assigned constructor slots",
	assignedRecord.a === 10 && assignedRecord.d === 13 && assignedRecord.h === 17,
);

class InitializedRecord {
	a = 1;
	b = 2;
	c = 3;
	d = 4;
	e = 5;
	f = 6;
	g = 7;
	h = 8;
}
let initializedRecord;
for (let i = 0; i < 64; i++) initializedRecord = new InitializedRecord();
check(
	"initialized constructor slots",
	initializedRecord.a === 1 && initializedRecord.d === 4 && initializedRecord.h === 8,
);

const retainedFour = [];
for (let i = 0; i < 2000; i++) {
	retainedFour.push({ a: i, b: "four:" + i, c: i + 2, d: i + 3 });
}
check(
	"retained four",
	retainedFour[1999].a === 1999 && retainedFour[1999].b === "four:1999",
);

const churn = [];
for (let i = 0; i < 500; i++) {
	churn.push({ value: i });
	check("churn", churn.pop().value === i);
}

const overwritten = { value: "before" };
overwritten.value = "after";
check("overwrite", overwritten.value === "after");

const grown = { value: 1 };
grown.extra = 2;
check("growth", grown.value === 1 && grown.extra === 2);

const grownFour = { a: 1, b: 2, c: 3, d: 4 };
grownFour.extra = 5;
check(
	"four-slot growth",
	grownFour.a === 1 && grownFour.d === 4 && grownFour.extra === 5,
);

function slotValue(index) {
	return index % 2 === 0 ? "string:" + index : { value: "object:" + index };
}

function matchesSlot(value, index) {
	return index % 2 === 0
		? value === "string:" + index
		: value.value === "object:" + index;
}

const dynamic = {};
const dynamicKeys = [];
for (let index = 0; index < 65; index++) {
	const key = "slot:" + index;
	dynamic[key] = slotValue(index);
	dynamicKeys.push(key);
	const count = index + 1;
	if (
		count === 1 ||
		count === 4 ||
		count === 5 ||
		count === 8 ||
		count === 9 ||
		count === 16 ||
		count === 17 ||
		count === 32 ||
		count === 33 ||
		count === 64 ||
		count === 65
	) {
		gc();
		let valuesIntact = true;
		for (let prior = 0; prior < count; prior++) {
			valuesIntact = valuesIntact && matchesSlot(dynamic["slot:" + prior], prior);
		}
		check("dynamic values at " + count, valuesIntact);
		check("dynamic keys at " + count, Object.keys(dynamic).join() === dynamicKeys.join());
		const descriptor = Object.getOwnPropertyDescriptor(dynamic, key);
		check(
			"dynamic descriptor at " + count,
			matchesSlot(descriptor.value, index) &&
				descriptor.writable &&
				descriptor.enumerable &&
				descriptor.configurable,
		);
		check("no unpublished slots at " + count, !("slot:" + count in dynamic));
	}
}

const staticGrowth = Object.create(null);
for (let index = 0; index < 32; index++) staticGrowth["s" + index] = slotValue(index);
gc();
staticGrowth.s32 = { value: "young:32" };
gc();
check(
	"static growth beyond the computed-key limit",
	Object.keys(staticGrowth).length === 33 &&
		staticGrowth.s0 === "string:0" &&
		staticGrowth.s31.value === "object:31" &&
		staticGrowth.s32.value === "young:32" &&
		!("s33" in staticGrowth),
);
staticGrowth.s33 = 33;
staticGrowth.s34 = 34;
staticGrowth.s35 = 35;
staticGrowth.s36 = 36;
staticGrowth.s37 = 37;
staticGrowth.s38 = 38;
staticGrowth.s39 = 39;
staticGrowth.s40 = 40;
staticGrowth.s41 = 41;
staticGrowth.s42 = 42;
staticGrowth.s43 = 43;
staticGrowth.s44 = 44;
staticGrowth.s45 = 45;
staticGrowth.s46 = 46;
staticGrowth.s47 = 47;
staticGrowth.s48 = 48;
staticGrowth.s49 = 49;
staticGrowth.s50 = 50;
staticGrowth.s51 = 51;
staticGrowth.s52 = 52;
staticGrowth.s53 = 53;
staticGrowth.s54 = 54;
staticGrowth.s55 = 55;
staticGrowth.s56 = 56;
staticGrowth.s57 = 57;
staticGrowth.s58 = 58;
staticGrowth.s59 = 59;
staticGrowth.s60 = 60;
staticGrowth.s61 = 61;
staticGrowth.s62 = 62;
staticGrowth.s63 = 63;
gc();
check(
	"static shaped limit",
	Object.keys(staticGrowth).length === 64 && !("s64" in staticGrowth),
);
staticGrowth.s64 = { value: "dictionary:64" };
gc();
const staticKeys = Object.keys(staticGrowth);
let staticValuesIntact = true;
for (let index = 0; index < 65; index++) {
	const value = staticGrowth["s" + index];
	staticValuesIntact =
		staticValuesIntact &&
		staticKeys[index] === "s" + index &&
		(index < 32
			? matchesSlot(value, index)
			: index === 32
				? value.value === "young:32"
				: index === 64
					? value.value === "dictionary:64"
					: value === index);
}
check("static dictionary transition retains all slots and order", staticValuesIntact);

const grownThree = { a: "three:a", b: { value: "three:b" }, c: "three:c" };
const grownFive = {
	a: "five:a",
	b: { value: "five:b" },
	c: "five:c",
	d: { value: "five:d" },
	e: "five:e",
};
gc();
grownThree.d = { value: "three:d" };
grownThree.e = "three:e";
grownFive.f = { value: "five:f" };
grownFive.g = "five:g";
gc();
check(
	"three-slot migration retains old and young values",
	grownThree.a === "three:a" &&
		grownThree.b.value === "three:b" &&
		grownThree.c === "three:c" &&
		grownThree.d.value === "three:d" &&
		grownThree.e === "three:e" &&
		Object.keys(grownThree).join() === "a,b,c,d,e",
);
check(
	"five-slot migration retains old and young values",
	grownFive.a === "five:a" &&
		grownFive.b.value === "five:b" &&
		grownFive.c === "five:c" &&
		grownFive.d.value === "five:d" &&
		grownFive.e === "five:e" &&
		grownFive.f.value === "five:f" &&
		grownFive.g === "five:g" &&
		Object.keys(grownFive).join() === "a,b,c,d,e,f,g",
);

function bindTarget(prefix, left, right) {
	return prefix + left + right;
}
const grownBound = bindTarget.bind(null, "bound:");
gc();
grownBound.first = { value: "first" };
gc();
grownBound.second = "second";
grownBound.third = { value: "third" };
gc();
check(
	"bound metadata survives migration and further growth",
	grownBound.length === 2 &&
		grownBound.name === "bound bindTarget" &&
		grownBound("left", "right") === "bound:leftright" &&
		grownBound.first.value === "first" &&
		grownBound.second === "second" &&
		grownBound.third.value === "third" &&
		Object.keys(grownBound).join() === "first,second,third",
);

const deletedGrowth = {};
for (let index = 0; index < 5; index++) deletedGrowth["slot:" + index] = slotValue(index);
check("delete from grown slots", delete deletedGrowth["slot:1"]);
deletedGrowth["slot:1"] = { value: "readded" };
gc();
check(
	"delete and readd preserve values and insertion order",
	deletedGrowth["slot:0"] === "string:0" &&
		deletedGrowth["slot:1"].value === "readded" &&
		deletedGrowth["slot:2"] === "string:2" &&
		deletedGrowth["slot:3"].value === "object:3" &&
		deletedGrowth["slot:4"] === "string:4" &&
		Object.keys(deletedGrowth).join() === "slot:0,slot:2,slot:3,slot:4,slot:1",
);

const accessorGrowth = {};
for (let index = 0; index < 5; index++)
	accessorGrowth["slot:" + index] = slotValue(index);
let accessorValue;
Object.defineProperty(accessorGrowth, "slot:2", {
	get() {
		return accessorValue;
	},
	set(value) {
		accessorValue = value;
	},
	enumerable: false,
	configurable: true,
});
accessorGrowth["slot:2"] = { value: "accessor" };
gc();
const accessorDescriptor = Object.getOwnPropertyDescriptor(accessorGrowth, "slot:2");
check(
	"grown data slot becomes an accessor",
	accessorGrowth["slot:2"].value === "accessor" &&
		typeof accessorDescriptor.get === "function" &&
		typeof accessorDescriptor.set === "function" &&
		!accessorDescriptor.enumerable &&
		accessorDescriptor.configurable &&
		Object.keys(accessorGrowth).join() === "slot:0,slot:1,slot:3,slot:4",
);
Object.defineProperty(accessorGrowth, "slot:2", {
	value: { value: "data again" },
	writable: false,
	enumerable: true,
	configurable: true,
});
accessorGrowth["slot:5"] = slotValue(5);
gc();
const dataDescriptor = Object.getOwnPropertyDescriptor(accessorGrowth, "slot:2");
check(
	"accessor becomes data without losing neighboring slots",
	dataDescriptor.value.value === "data again" &&
		!dataDescriptor.writable &&
		dataDescriptor.enumerable &&
		dataDescriptor.configurable &&
		accessorGrowth["slot:0"] === "string:0" &&
		accessorGrowth["slot:1"].value === "object:1" &&
		accessorGrowth["slot:3"].value === "object:3" &&
		accessorGrowth["slot:4"] === "string:4" &&
		accessorGrowth["slot:5"].value === "object:5" &&
		Object.keys(accessorGrowth).join() === "slot:0,slot:1,slot:2,slot:3,slot:4,slot:5",
);

const deleted = { value: 3 };
check("delete", delete deleted.value && !("value" in deleted));

const deletedFour = { a: 1, b: 2, c: 3, d: 4 };
check(
	"four-slot delete",
	delete deletedFour.b && deletedFour.a === 1 && !("b" in deletedFour),
);

const indexed = { value: 4 };
indexed[0] = 5;
check("index", indexed.value === 4 && indexed[0] === 5);

const symbol = Symbol("slot");
const symbolized = { value: 6 };
symbolized[symbol] = 7;
check("symbol", symbolized.value === 6 && symbolized[symbol] === 7);

const frozen = Object.freeze({ value: 8 });
check("freeze", frozen.value === 8 && Object.isFrozen(frozen));

const sealed = Object.seal({ value: 9 });
check("seal", sealed.value === 9 && Object.isSealed(sealed));

const fixed = Object.preventExtensions({ value: 10 });
fixed.value = 11;
check("prevent extensions", fixed.value === 11 && !Object.isExtensible(fixed));

const wide16 = {
	k0: 0,
	k1: 1,
	k2: 2,
	k3: 3,
	k4: 4,
	k5: 5,
	k6: 6,
	k7: 7,
	k8: 8,
	k9: 9,
	k10: 10,
	k11: 11,
	k12: 12,
	k13: 13,
	k14: 14,
	k15: 15,
};
check("sixteen slots", wide16.k0 === 0 && wide16.k7 === 7 && wide16.k15 === 15);

const wide32 = {
	k0: 0,
	k1: 1,
	k2: 2,
	k3: 3,
	k4: 4,
	k5: 5,
	k6: 6,
	k7: 7,
	k8: 8,
	k9: 9,
	k10: 10,
	k11: 11,
	k12: 12,
	k13: 13,
	k14: 14,
	k15: 15,
	k16: 16,
	k17: 17,
	k18: 18,
	k19: 19,
	k20: 20,
	k21: 21,
	k22: 22,
	k23: 23,
	k24: 24,
	k25: 25,
	k26: 26,
	k27: 27,
	k28: 28,
	k29: 29,
	k30: 30,
	k31: 31,
};
check("thirty-two slots", wide32.k0 === 0 && wide32.k16 === 16 && wide32.k31 === 31);

console.log("object-slot-coallocation PASS " + passed + "/" + passed);
