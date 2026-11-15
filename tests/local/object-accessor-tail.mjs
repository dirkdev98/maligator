import assert from "node:assert/strict";

const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});

const cases = {
	allocation() {
		const count = Number(process.env.OBJECT_ACCESSOR_TAIL_COUNT ?? 64);
		const records = [];
		for (let index = 0; index < count; index++) {
			const record = { first: index, second: index + 1, third: index + 2 };
			if (process.env.OBJECT_ACCESSOR_TAIL_CONTROL !== "1") {
				Object.defineProperty(record, "sum", {
					get() {
						return this.first + this.second;
					},
					configurable: true,
				});
			}
			records.push(record);
		}
		assert.equal(records.at(-1).first, count - 1);
	},
	order() {
		const record = { first: 1, second: 2 };
		Object.defineProperty(record, "sum", {
			get() {
				return this.first + this.second;
			},
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(record, "hidden", { value: 9, configurable: true });
		record.last = 4;
		assert.deepEqual(Reflect.ownKeys(record), [
			"first",
			"second",
			"sum",
			"hidden",
			"last",
		]);
		assert.deepEqual(Object.keys(record), ["first", "second", "sum", "last"]);
		assert.deepEqual(Object.values(record), [1, 2, 3, 4]);
		assert.deepEqual(Object.entries(record), [
			["first", 1],
			["second", 2],
			["sum", 3],
			["last", 4],
		]);
		assert.deepEqual({ ...record }, { first: 1, second: 2, sum: 3, last: 4 });
		assert.equal(JSON.stringify(record), '{"first":1,"second":2,"sum":3,"last":4}');
	},
	conversion() {
		const record = { first: 1, second: 2, third: 3 };
		let stored = 7;
		Object.defineProperty(record, "tail", {
			get() {
				return stored;
			},
			set(value) {
				stored = value;
			},
			enumerable: true,
			configurable: true,
		});
		record.last = 5;
		Object.defineProperty(record, "second", { get: () => 20 });
		record.tail = 9;
		assert.deepEqual(Object.keys(record), ["first", "second", "third", "tail", "last"]);
		assert.deepEqual(Object.values(record), [1, 20, 3, 9, 5]);
		assert.equal(typeof Object.getOwnPropertyDescriptor(record, "tail").set, "function");
		assert.equal(Reflect.defineProperty(record, "second", { value: 2 }), true);
		assert.deepEqual(Object.values(record), [1, 2, 3, 9, 5]);
	},
	deletion() {
		const record = { first: 1, second: 2, third: 3 };
		Object.defineProperty(record, "tail", {
			get: () => 4,
			configurable: true,
			enumerable: true,
		});
		assert.equal(delete record.second, true);
		assert.equal(delete record.tail, true);
		record.second = 20;
		Object.defineProperty(record, "tail", { get: () => 40, enumerable: true });
		assert.deepEqual(Object.keys(record), ["first", "third", "second", "tail"]);
		assert.deepEqual(Object.values(record), [1, 3, 20, 40]);
		assert.equal(Reflect.deleteProperty(record, "tail"), false);
	},
	emptyPrefix() {
		const record = { first: 1, second: 2, third: 3 };
		Object.defineProperty(record, "tail", {
			get: () => 4,
			configurable: true,
			enumerable: true,
		});
		delete record.first;
		delete record.second;
		delete record.third;
		class Base {
			constructor() {
				return record;
			}
		}
		class Derived extends Base {
			tail = 40;
			last = 5;
		}
		const instance = new Derived();
		assert.equal(instance, record);
		assert.deepEqual(Object.keys(instance), ["tail", "last"]);
		assert.deepEqual(Object.values(instance), [40, 5]);
	},
	integrity() {
		for (const freeze of [false, true]) {
			const record = { first: { value: 1 }, second: 2 };
			let stored = 3;
			Object.defineProperty(record, "tail", {
				get: () => stored,
				set: (value) => {
					stored = value;
				},
				enumerable: true,
				configurable: true,
			});
			record.last = 4;
			if (freeze) Object.freeze(record);
			else Object.seal(record);
			assert.equal(Object.isSealed(record), true);
			assert.equal(Object.isFrozen(record), freeze);
			assert.equal(Reflect.set(record, "second", 20), !freeze);
			assert.equal(Reflect.set(record, "tail", 30), true);
			assert.equal(record.tail, 30);
			assert.equal(Reflect.set(record, "newField", 5), false);
			assert.equal(Reflect.deleteProperty(record, "tail"), false);
			assert.deepEqual(Object.keys(record), ["first", "second", "tail", "last"]);
		}
		const record = { first: 1 };
		Object.defineProperty(record, "tail", { get: () => 2, configurable: true });
		Object.preventExtensions(record);
		assert.equal(Reflect.defineProperty(record, "absent", { get: () => 3 }), false);
		assert.equal(Reflect.defineProperty(record, "tail", { value: 4 }), true);
		assert.equal(record.tail, 4);
	},
	caches() {
		const prototype = { inherited: 10 };
		const read = (record) => [record.first, record.inherited, record.absent];
		const membership = (record) => [Object.hasOwn(record, "absent"), "absent" in record];
		for (let round = 0; round < 10; round++) {
			const record = { first: round };
			Object.setPrototypeOf(record, prototype);
			assert.deepEqual(read(record), [round, 10, undefined]);
			assert.deepEqual(membership(record), [false, false]);
			Object.defineProperty(record, "inherited", { get: () => 20, configurable: true });
			Object.defineProperty(record, "absent", { get: () => 30, configurable: true });
			assert.deepEqual(read(record), [round, 20, 30]);
			assert.deepEqual(membership(record), [true, true]);
			delete record.inherited;
			assert.deepEqual(read(record), [round, 10, 30]);
			record.first = 99;
			assert.deepEqual(read(record), [99, 10, 30]);
			const child = Object.create(record);
			assert.deepEqual(read(child), [99, 10, 30]);
			assert.deepEqual(membership(child), [false, true]);
			Object.defineProperty(record, "absent", { value: 40 });
			assert.deepEqual(read(child), [99, 10, 40]);
		}
	},
	keys() {
		const record = { first: 1, second: 2 };
		Object.defineProperty(record, "tail", { get: () => 3, enumerable: true });
		record[9] = 9;
		record[1] = 1;
		const symbol = Symbol("fictional");
		record[symbol] = 4;
		record.last = 5;
		assert.deepEqual(Reflect.ownKeys(record), [
			"1",
			"9",
			"first",
			"second",
			"tail",
			"last",
			symbol,
		]);
		assert.deepEqual(Object.values(record), [1, 9, 1, 2, 3, 5]);
	},
	privateFields() {
		class Record {
			#value = { count: 1 };
			first = 2;
			read() {
				return this.#value.count;
			}
			increment() {
				return ++this.#value.count;
			}
		}
		const record = new Record();
		Object.defineProperty(record, "tail", {
			get() {
				return this.read();
			},
			enumerable: true,
		});
		for (let index = 0; index < 80; index++) record[`field${index}`] = index;
		collectGarbage();
		assert.equal(record.increment(), 2);
		assert.equal(record.tail, 2);
		Object.freeze(record);
		collectGarbage();
		assert.equal(record.increment(), 3);
		assert.equal(record.tail, 3);
		assert.equal(Object.getOwnPropertySymbols(record).length, 0);
		assert.equal(Object.keys(record).at(0), "first");
	},
	reentry() {
		const record = { first: { value: 1 } };
		let calls = 0;
		Object.defineProperty(record, "tail", {
			get() {
				calls++;
				collectGarbage();
				Object.defineProperty(record, "first", { writable: false });
				delete record.last;
				record.added = 4;
				return { value: 2 };
			},
			enumerable: true,
		});
		record.last = { value: 3 };
		assert.deepEqual(Object.values(record), [{ value: 1 }, { value: 2 }]);
		assert.equal(calls, 1);
		assert.deepEqual(Object.keys(record), ["first", "tail", "added"]);
	},
};

const name = process.env.OBJECT_ACCESSOR_TAIL_CASE;
assert.equal(typeof cases[name], "function");
cases[name]();
console.log(`PASS ${name}`);
