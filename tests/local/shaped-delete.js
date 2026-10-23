const gc = globalThis.__mal_collect_garbage ?? (() => {});
const mode = globalThis.process?.env?.SHAPED_DELETE_MODE ?? "shaped";

let passed = 0;
function check(label, condition) {
	if (!condition) throw new Error(label);
	passed++;
}

function readAll(object) {
	return [object.a, object.b?.v, object.c, object.d?.v, object.e].join();
}

function deleteEachPosition() {
	const expected = {
		a: ",2,3,4,5",
		c: "1,2,,4,5",
		e: "1,2,3,4,",
	};
	for (const victim of ["a", "c", "e"]) {
		for (let round = 0; round < 200; round++) {
			const object = { a: 1, b: { v: 2 }, c: 3, d: { v: 4 }, e: 5 };
			readAll(object);
			if (round % 50 === 0) gc();
			check("delete " + victim, delete object[victim]);
			check("reads after deleting " + victim, readAll(object) === expected[victim]);
			check("absent " + victim, !(victim in object) && object[victim] === undefined);
			object[victim] = "again";
			const order = ["a", "b", "c", "d", "e"].filter((key) => key !== victim);
			order.push(victim);
			check("readd order " + victim, Object.keys(object).join() === order.join());
			check("readd value " + victim, object[victim] === "again");
		}
	}
}

function deletedMatchesFreshLayout() {
	const fresh = { b: { v: 2 }, d: { v: 4 }, e: 5 };
	const deleted = { a: 1, b: { v: 2 }, c: 3, d: { v: 4 }, e: 5 };
	delete deleted.a;
	delete deleted.c;
	check("same keys as fresh", Object.keys(fresh).join() === Object.keys(deleted).join());
	check("same JSON as fresh", JSON.stringify(fresh) === JSON.stringify(deleted));
	const seen = [];
	for (const key in deleted) seen.push(key);
	check("for-in after delete", seen.join() === "b,d,e");
}

function attributesSurvive() {
	const object = { a: 1, b: 2, c: 3, d: 4 };
	Object.defineProperty(object, "b", { value: 20, writable: false, configurable: false });
	Object.defineProperty(object, "c", { enumerable: false });
	check("delete before attributed", delete object.a);
	check(
		"non-configurable stays",
		!Reflect.deleteProperty(object, "b") && object.b === 20,
	);
	const b = Object.getOwnPropertyDescriptor(object, "b");
	check("attributes kept", !b.writable && !b.configurable && b.enumerable);
	check("hidden kept hidden", Object.keys(object).join() === "b,d");
	check(
		"hidden readable",
		object.c === 3 && Object.getOwnPropertyNames(object).join() === "b,c,d",
	);
	check("read-only kept", !Reflect.set(object, "b", 99) && object.b === 20);
}

class Holder {
	#secret;
	constructor(value) {
		this.first = 1;
		this.#secret = value;
		this.last = 2;
	}
	secret() {
		return this.#secret;
	}
}

function privateElementsSurvive() {
	for (let i = 0; i < 100; i++) {
		const holder = new Holder({ v: i });
		check("delete public", delete holder.first);
		if (i % 25 === 0) gc();
		check("private after delete", holder.secret().v === i && holder.last === 2);
		check("public keys", Object.keys(holder).join() === "last");
	}
}

function eventsChurn() {
	const events = Object.create(null);
	const added = ["aborted", "close", "data", "end", "error"];
	const removed = ["aborted", "data", "end", "error", "close"];
	for (let round = 0; round < 400; round++) {
		for (const type of added) events[type] = { round, type };
		if (round % 100 === 0) gc();
		for (let i = 0; i < removed.length; i++) {
			delete events[removed[i]];
			const left = added.filter((type) => !removed.slice(0, i + 1).includes(type));
			check("events keys", Object.keys(events).join() === left.join());
			check(
				"events values",
				left.every((type) => events[type].type === type && events[type].round === round),
			);
		}
	}
}

function symbolsAndIndices() {
	const symbol = Symbol("s");
	const object = { a: 1, [symbol]: 2, b: 3, 0: "zero" };
	check(
		"delete beside symbol",
		delete object.a && object[symbol] === 2 && object[0] === "zero",
	);
	check("keys beside symbol", Object.keys(object).join() === "0,b");
	const array = [1, 2];
	array.extra = 1;
	array.more = 2;
	check(
		"array named delete",
		delete array.extra && array.more === 2 && array.length === 2,
	);
}

// Each delete replays a never-seen key after the deleted one, so later objects
// outlast the heap's removal budget and must stay correct in dictionary mode.
function budgetChurn() {
	const objects = [];
	for (let i = 0; i < 6000; i++) {
		const object = {};
		object.a = i;
		object.x = "drop";
		object["unique" + i] = { v: i };
		object.z = -i;
		delete object.x;
		objects.push(object);
	}
	gc();
	for (let i = 0; i < objects.length; i++) {
		const object = objects[i];
		check("budget keys", Object.keys(object).join() === "a,unique" + i + ",z");
		check(
			"budget values",
			object.a === i && object["unique" + i].v === i && object.z === -i,
		);
		delete object.a;
		check("budget second delete", Object.keys(object).join() === "unique" + i + ",z");
	}
}

if (mode === "baseline") {
	check("baseline", true);
} else if (mode === "budget") {
	budgetChurn();
} else {
	deleteEachPosition();
	deletedMatchesFreshLayout();
	attributesSurvive();
	privateElementsSurvive();
	eventsChurn();
	symbolsAndIndices();
}

console.log("shaped-delete PASS " + passed + "/" + passed);
