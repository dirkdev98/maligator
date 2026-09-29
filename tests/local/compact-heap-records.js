const inspect = globalThis.__compact_record_layout;
const gc = globalThis.__mal_collect_garbage;
if (typeof inspect !== "function" || typeof gc !== "function") {
	throw new Error("compact heap records require the storage probe and MAL_HOST_GC=1");
}

function check(label, condition) {
	if (!condition) throw new Error(label);
}

function makeRecord(id) {
	return { id, weight: id + 0.5, link: { value: id * 2 }, note: undefined };
}

function readId(record) {
	return record.id;
}

function readTotal(record) {
	return record.id + record.weight + record.link.value;
}

function updateRecord(record, amount) {
	record.id += amount;
	record.weight += 0.25;
	record.link = { value: record.id * 3 };
	record.note = { retained: record.id + 10 };
}

function reflectRecord(record, expectedKeys) {
	check("own key order", Reflect.ownKeys(record).join(",") === expectedKeys);
	const id = Object.getOwnPropertyDescriptor(record, "id");
	check(
		"reflected data descriptor",
		id.value === readId(record) && id.writable && id.enumerable && id.configurable,
	);
}

function widenRecord(record) {
	record.id = { marker: "wide" };
}

const retained = [];
const identities = new Map();
for (let index = 0; index < 96; index++) {
	const record = makeRecord(index);
	retained.push(record);
	identities.set(record, index);
}
gc();

const selected = retained[7];
const alias = selected;
check("materialized mixed physical fields", inspect(selected) === 63);
for (let index = 0; index < 64; index++) {
	check(
		"cross-function cached reads",
		readId(selected) === 7 && readTotal(selected) === 28.5,
	);
}
reflectRecord(selected, "id,weight,link,note");
check("reflection preserves compact storage", inspect(selected) === 63);

updateRecord(selected, 5);
gc();
check(
	"raw and tagged young references survive",
	selected.link.value === 36 && selected.note.retained === 22,
);
check("typed updates stay compact", inspect(selected) === 63);
check("updated cross-function read", readTotal(selected) === 55.75);

widenRecord(selected);
gc();
check(
	"same identity after generalization",
	selected === alias && retained[7] === alias && identities.get(alias) === 7,
);
check("widened record stays inline with tagged fields", (inspect(selected) & 35) === 35);
check("cached load observes new representation", readId(selected).marker === "wide");
check(
	"generalization preserves other fields",
	selected.weight === 7.75 && selected.link.value === 36 && selected.note.retained === 22,
);
reflectRecord(selected, "id,weight,link,note");

selected.extra = 17;
check("added field moves to external storage", (inspect(selected) & 65) === 65);
reflectRecord(selected, "id,weight,link,note,extra");
let getterCalls = 0;
let setterCalls = 0;
let backing = selected.weight;
const getter = function () {
	getterCalls++;
	return backing;
};
const setter = function (value) {
	setterCalls++;
	backing = value;
};
Object.defineProperty(selected, "weight", {
	get: getter,
	set: setter,
	enumerable: true,
	configurable: true,
});
selected.weight = 41.5;
check(
	"accessor transition",
	selected.weight === 41.5 && getterCalls === 1 && setterCalls === 1,
);
const accessor = Object.getOwnPropertyDescriptor(selected, "weight");
check(
	"accessor reflection",
	accessor.get === getter && accessor.set === setter && !("value" in accessor),
);
delete selected.link;
gc();
check(
	"delete removes only the selected field",
	!Object.hasOwn(selected, "link") && selected.note.retained === 22,
);
check(
	"delete preserves key order",
	Object.keys(selected).join(",") === "id,weight,note,extra",
);

const prototype = { inherited: 73, link: { value: 9 } };
Object.setPrototypeOf(selected, prototype);
gc();
check(
	"prototype transition retains identity",
	Object.getPrototypeOf(alias) === prototype && identities.get(selected) === 7,
);
for (let index = 0; index < 32; index++)
	check("inherited cached read", selected.inherited === 73);
Object.setPrototypeOf(selected, { inherited: 91 });
check(
	"prototype cache invalidation",
	selected.inherited === 91 && selected.link === undefined,
);

const added = retained[8];
check("fresh addition starts compact", inspect(added) === 63);
added.extra = { live: 81 };
gc();
check(
	"direct compact addition",
	added.id === 8 && added.link.value === 16 && added.extra.live === 81,
);

const deleted = retained[9];
check("fresh deletion starts compact", inspect(deleted) === 63);
delete deleted.weight;
check(
	"direct compact deletion",
	Object.keys(deleted).join(",") === "id,link,note" && deleted.link.value === 18,
);

const accessorRecord = retained[10];
Object.defineProperty(accessorRecord, "id", {
	get() {
		return 101;
	},
	configurable: true,
});
check(
	"direct compact accessor",
	readId(accessorRecord) === 101 && accessorRecord.weight === 10.5,
);

const reparented = retained[11];
Object.setPrototypeOf(reparented, { inherited: 111 });
gc();
check(
	"direct compact prototype mutation",
	reparented.inherited === 111 && readTotal(reparented) === 44.5,
);

const sealed = retained[12];
Object.seal(sealed);
updateRecord(sealed, 1);
gc();
check(
	"sealed layout retains packed fields",
	inspect(sealed) === 63 && Object.isSealed(sealed) && sealed.note.retained === 23,
);
const frozen = retained[13];
Object.freeze(frozen);
check(
	"frozen layout retains packed fields",
	inspect(frozen) === 63 && Object.isFrozen(frozen),
);
check(
	"frozen representation-changing write rejected",
	!Reflect.set(frozen, "id", { wrong: true }) && frozen.id === 13,
);

for (const value of [-0, NaN, Infinity, -Infinity, 2147483648, 1.25]) {
	const record = makeRecord(20);
	retained.push(record);
	record.id = value;
	gc();
	check("widened Number keeps SameValue", Object.is(record.id, value));
	check(
		"widened Number descriptor keeps SameValue",
		Object.is(Object.getOwnPropertyDescriptor(record, "id").value, value),
	);
}

const numeric = retained[14];
for (const value of [-0, NaN, Infinity, -Infinity, 1, 1.25]) {
	numeric.weight = value;
	gc();
	check(
		"F64 Number round trip",
		Object.is(numeric.weight, value) && inspect(numeric) === 63,
	);
}
numeric.link = "heap class";
gc();
check("raw pointer reboxes String", numeric.link === "heap class");
numeric.link = function () {
	return 142;
};
gc();
check("raw pointer reboxes callable", numeric.link() === 142);
numeric.link = numeric;
gc();
check("raw pointer retains cycle", numeric.link === numeric);

function makeVariant(variantLeft, variantRight) {
	return { variantLeft, variantRight };
}
const variants = [];
const values = [1, 1.5, { live: "variant" }, undefined];
for (const left of values) {
	for (const right of values) variants.push(makeVariant(left, right));
}
gc();
for (let index = 0; index < variants.length; index++) {
	const variant = variants[index];
	check(
		"bounded variant fallback retains values",
		variant.variantLeft === values[(index / 4) | 0] &&
			variant.variantRight === values[index & 3],
	);
	check("variant fallback stays materialized and compact", (inspect(variant) & 3) === 3);
	Object.freeze(variant);
	check(
		"variant integrity preserves values",
		Object.isFrozen(variant) && variant.variantLeft === values[(index / 4) | 0],
	);
}

function makeFamilyRecord(left, right) {
	return { familyLeft: left, familyRight: right };
}

function replaceFamilyLeft(record, value) {
	record.familyLeft = value;
}

const narrowVariant = makeFamilyRecord(1, 2);
const wideVariant = makeFamilyRecord(1.5, 2);
for (let index = 0; index < 32; index++) {
	replaceFamilyLeft(narrowVariant, index);
	replaceFamilyLeft(wideVariant, index + 0.5);
}
check(
	"one store site follows each physical layout",
	narrowVariant.familyLeft === 31 &&
		wideVariant.familyLeft === 31.5 &&
		wideVariant.familyRight === 2,
);
Object.defineProperty(wideVariant, "familyLeft", { writable: false });
try {
	replaceFamilyLeft(wideVariant, 100);
} catch (error) {
	check("read-only store throws TypeError", error instanceof TypeError);
}
check("read-only layout rejects cached write", wideVariant.familyLeft === 31.5);

function incrementId(record) {
	record.id++;
	return record.id;
}

function multiplyIntoWeight(record, factor) {
	record.weight = record.id * factor;
	return record.weight;
}

function appendToId(record, suffix) {
	record.id += suffix;
	return record.id;
}

function accumulatedFields(record, initial) {
	const id = record.id;
	const subtotal = initial + id;
	const weight = record.weight;
	return subtotal + weight;
}

function advanceVelocity(record) {
	record.vy += 0.01 * record.mass;
	return record.vy;
}

const particle = { vy: 1, mass: 2 };
let expectedVelocity = 1;
for (let index = 0; index < 48; index++) {
	expectedVelocity += 0.02;
	check("two-step typed field update", advanceVelocity(particle) === expectedVelocity);
}
particle.mass = "3";
expectedVelocity += 0.03;
check(
	"two-step update generalizes operand",
	advanceVelocity(particle) === expectedVelocity,
);
const accessOrder = [];
const observed = new Proxy(
	{ vy: 2, mass: 4 },
	{
		get(target, key, receiver) {
			if (key === "vy" || key === "mass") accessOrder.push(`get:${key}`);
			return Reflect.get(target, key, receiver);
		},
		set(target, key, value, receiver) {
			accessOrder.push(`set:${key}`);
			return Reflect.set(target, key, value, receiver);
		},
	},
);
check("two-step Proxy fallback", advanceVelocity(observed) === 2.04);
check(
	"two-step fallback preserves effects",
	accessOrder.join(",") === "get:vy,get:mass,set:vy,get:vy",
);

function advanceBatch(records) {
	for (const record of records) record.vy += 0.01 * record.mass;
}

const batched = { vy: 1, mass: 2 };
for (let index = 0; index < 32; index++) advanceBatch([batched]);
check("batched numeric update", batched.vy > 1.63 && batched.vy < 1.65);
let batchGetterCalls = 0;
const batchedGetter = {
	vy: 5,
	get mass() {
		batchGetterCalls++;
		this.vy = 100;
		return 4;
	},
};
advanceBatch([batchedGetter]);
check(
	"batched getter observes read-before-write order",
	batchedGetter.vy === 5.04 && batchGetterCalls === 1,
);
const batchError = new Error("batch getter");
let iteratorClosed = 0;
const throwingBatch = {
	[Symbol.iterator]() {
		let yielded = false;
		return {
			next() {
				if (yielded) return { done: true };
				yielded = true;
				return {
					value: {
						vy: 1,
						get mass() {
							throw batchError;
						},
					},
					done: false,
				};
			},
			return() {
				iteratorClosed++;
				return { done: true };
			},
		};
	},
};
try {
	advanceBatch(throwingBatch);
	throw new Error("batched getter did not throw");
} catch (error) {
	check("batched getter preserves the thrown value", error === batchError);
}
check("batched getter closes the iterator", iteratorClosed === 1);

function addPacked(record) {
	record.left = record.left + record.right;
	return record.left;
}

const overflowingPair = { left: 2147483645, right: 1 };
check("packed pair warms its store", addPacked(overflowingPair) === 2147483646);
check("packed pair reaches int32 limit", addPacked(overflowingPair) === 2147483647);
check(
	"packed pair widens without losing identity",
	addPacked(overflowingPair) === 2147483648,
);
check(
	"packed pair reflects widened Number",
	Object.getOwnPropertyDescriptor(overflowingPair, "left").value === 2147483648,
);

function dividePacked(record) {
	record.left = record.left / record.right;
	return record.left;
}

const signedPair = { left: 1, right: -1 };
check("packed division warms its store", dividePacked(signedPair) === -1);
signedPair.left = 0;
check(
	"packed pair preserves negative zero",
	Object.is(dividePacked(signedPair), -0) &&
		Object.is(Object.getOwnPropertyDescriptor(signedPair, "left").value, -0),
);

const observablePair = { left: 1, right: 2 };
for (let index = 0; index < 16; index++) addPacked(observablePair);
observablePair.left = 1;
let secondGetterCalls = 0;
Object.defineProperty(observablePair, "right", {
	get() {
		secondGetterCalls++;
		observablePair.left = 10;
		return 4;
	},
	configurable: true,
});
check(
	"second getter mutates the first field between read and write",
	addPacked(observablePair) === 5 && observablePair.left === 5 && secondGetterCalls === 1,
);

const over = { id: 2147483646 };
const overAlias = over;
check("increment reaches int32 limit", incrementId(over) === 2147483647);
check(
	"increment widens without changing identity",
	incrementId(over) === 2147483648 && over === overAlias,
);
check(
	"widened increment reflects Number",
	Object.getOwnPropertyDescriptor(over, "id").value === 2147483648,
);

const signed = { id: 0, weight: 1 };
multiplyIntoWeight(signed, 1);
check(
	"numeric update preserves negative zero",
	Object.is(multiplyIntoWeight(signed, -0), -0) &&
		Object.is(Object.getOwnPropertyDescriptor(signed, "weight").value, -0),
);

const concatenated = { id: 3 };
check("numeric addition warms its field", appendToId(concatenated, 2) === 5);
check("string addition still concatenates", appendToId(concatenated, "z") === "5z");
const bigint = { id: 1n };
check("BigInt increment remains BigInt", incrementId(bigint) === 2n);

const accessorUpdate = { id: 1 };
incrementId(accessorUpdate);
let numericGetterCalls = 0;
let numericSetterCalls = 0;
let numericBacking = 5;
Object.defineProperty(accessorUpdate, "id", {
	get() {
		numericGetterCalls++;
		return numericBacking;
	},
	set(value) {
		numericSetterCalls++;
		numericBacking = value;
	},
	configurable: true,
});
incrementId(accessorUpdate);
check(
	"numeric update honors accessor transition",
	numericBacking === 6 && numericGetterCalls === 2 && numericSetterCalls === 1,
);

const prototypeUpdate = { id: 1 };
incrementId(prototypeUpdate);
const inheritedUpdate = Object.create(prototypeUpdate);
check("inherited value before prototype write", inheritedUpdate.id === 2);
incrementId(prototypeUpdate);
check("prototype write invalidates inherited value", inheritedUpdate.id === 3);

const projection = { id: 3, weight: 4 };
for (let index = 0; index < 16; index++)
	check("separated numeric reads", accumulatedFields(projection, index) === index + 7);
check(
	"boxed string input resumes ordered addition",
	accumulatedFields(projection, "x") === "x34",
);
let projectedGetterCalls = 0;
Object.defineProperty(projection, "id", {
	get() {
		projectedGetterCalls++;
		projection.weight = 9;
		return 2;
	},
	configurable: true,
});
check(
	"separated read respects accessor effects",
	accumulatedFields(projection, 1) === 12 && projectedGetterCalls === 1,
);

function* numbers() {
	yield 3;
}
function readGeneratorNext(generator) {
	return generator.next;
}
const generator = numbers();
const generatorPrototype = Object.getPrototypeOf(generator);
const builtinNext = readGeneratorNext(generator);
for (let index = 0; index < 32; index++)
	check("generator inherited method cache", readGeneratorNext(generator) === builtinNext);
const replacementNext = function () {
	return { value: 11, done: true };
};
generatorPrototype.next = replacementNext;
check("generator prototype mutation", readGeneratorNext(generator) === replacementNext);
let inheritedGetterCalls = 0;
Object.defineProperty(generatorPrototype, "next", {
	get() {
		inheritedGetterCalls++;
		return replacementNext;
	},
	configurable: true,
});
check(
	"generator inherited accessor remains observable",
	readGeneratorNext(generator) === replacementNext &&
		readGeneratorNext(generator) === replacementNext &&
		inheritedGetterCalls === 2,
);
delete generatorPrototype.next;
check("generator prototype deletion", readGeneratorNext(generator) === builtinNext);
generator.next = replacementNext;
check("generator own shadow", readGeneratorNext(generator) === replacementNext);
delete generator.next;
check("generator own deletion", readGeneratorNext(generator) === builtinNext);
Object.setPrototypeOf(generator, { next: replacementNext });
check(
	"generator prototype replacement",
	readGeneratorNext(generator) === replacementNext,
);
Object.setPrototypeOf(generator, generatorPrototype);
check("generator prototype restoration", readGeneratorNext(generator) === builtinNext);
let proxyReads = 0;
const generatorProxyPrototype = new Proxy(
	{ next: replacementNext },
	{
		get(target, key, receiver) {
			if (key === "next") proxyReads++;
			return Reflect.get(target, key, receiver);
		},
	},
);
Object.setPrototypeOf(generator, generatorProxyPrototype);
check(
	"generator Proxy prototype dispatch",
	readGeneratorNext(generator) === replacementNext &&
		readGeneratorNext(generator) === replacementNext &&
		proxyReads === 2,
);
Object.setPrototypeOf(generator, generatorPrototype);
gc();
check(
	"generator inherited method survives collection",
	readGeneratorNext(generator) === builtinNext,
);
function* otherNumbers() {
	yield 4;
}
const otherGenerator = otherNumbers();
otherNumbers.prototype.next = replacementNext;
check(
	"generator cache guards prototype identity",
	readGeneratorNext(otherGenerator) === replacementNext,
);
check(
	"generator cache retains original prototype",
	readGeneratorNext(generator) === builtinNext,
);

console.log("compact-heap-records PASS");
