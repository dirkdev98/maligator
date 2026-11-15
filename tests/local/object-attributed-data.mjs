const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function check(condition, message) {
	if (!condition) throw new Error(message);
}
function keys(record) {
	return Reflect.ownKeys(record).map(String).join(",");
}

const cases = {
	descriptors() {
		for (let flags = 0; flags < 8; flags++) {
			const record = { head: 1 };
			const value = { flags };
			const writable = (flags & 1) !== 0;
			const enumerable = (flags & 2) !== 0;
			const configurable = (flags & 4) !== 0;
			Object.defineProperty(record, "value", {
				value,
				writable,
				enumerable,
				configurable,
			});
			collect();
			const descriptor = Object.getOwnPropertyDescriptor(record, "value");
			check(record.value === value && descriptor.value === value, "value identity");
			check(descriptor.writable === writable, "writable");
			check(descriptor.enumerable === enumerable, "enumerable");
			check(descriptor.configurable === configurable, "configurable");
			check(keys(record) === "head,value", "own order");
			check(Reflect.defineProperty(record, "value", { value }), "same descriptor");
		}
	},
	compatibility() {
		for (const [original, next, accepted] of [
			[NaN, NaN, true],
			[0, -0, false],
			[-0, 0, false],
			[7, 7, true],
			[7, 8, false],
		]) {
			const record = { head: 1 };
			Object.defineProperty(record, "value", { value: original });
			collect();
			check(
				Reflect.defineProperty(record, "value", { value: next }) === accepted,
				"SameValue",
			);
			check(Object.is(record.value, original), "readonly value");
			check(!Reflect.deleteProperty(record, "value"), "nonconfigurable deletion");
			check(!Reflect.set(record, "value", 99), "readonly store");
		}
		const closed = Object.preventExtensions({ head: 1 });
		check(!Reflect.defineProperty(closed, "hidden", { value: 1 }), "closed append");
	},
	enumeration() {
		const record = { head: 1 };
		Object.defineProperty(record, "hidden", { value: 2 });
		Object.defineProperty(record, "visible", { value: 3, enumerable: true });
		record.tail = 4;
		collect();
		for (let round = 0; round < 4; round++) {
			check(Object.keys(record).join() === "head,visible,tail", "keys");
			check(Object.values(record).join() === "1,3,4", "values");
			check(
				Object.entries(record).flat().join() === "head,1,visible,3,tail,4",
				"entries",
			);
			check(keys(record) === "head,hidden,visible,tail", "names");
			check(keys({ ...record }) === "head,visible,tail", "spread");
			check(keys(Object.assign({}, record)) === "head,visible,tail", "assign");
			check(JSON.stringify(record) === '{"head":1,"visible":3,"tail":4}', "JSON");
			const visited = [];
			for (const key in record) visited.push(key);
			check(visited.join() === "head,visible,tail", "for-in");
		}
		const child = Object.create({ hidden: 9, inherited: 8 });
		child.head = 1;
		Object.defineProperty(child, "hidden", { value: 2 });
		const visited = [];
		for (const key in child) visited.push(key);
		check(visited.join() === "head,inherited", "nonenumerable shadow");
	},
	caches() {
		function read(record) {
			return record.value;
		}
		function write(record) {
			try {
				record.value = 99;
			} catch (error) {
				return error instanceof TypeError;
			}
			return false;
		}
		const records = [];
		for (let index = 0; index < 10; index++) {
			const record = { ["prefix" + index]: index };
			Object.defineProperty(record, "value", { value: index });
			records.push(record);
		}
		for (let round = 0; round < 20; round++)
			for (let index = 0; index < records.length; index++)
				check(read(records[index]) === index, "cached load");
		collect();
		for (let index = 0; index < records.length; index++) {
			check(write(records[index]), "cached readonly store");
			check(read(records[index]) === index, "cached value unchanged");
		}
	},
	prototype() {
		const prototype = { head: 1 };
		function write(record) {
			record.value = 7;
		}
		for (let round = 0; round < 20; round++) write(Object.create(prototype));
		Object.defineProperty(prototype, "value", { value: 3 });
		collect();
		const child = Object.create(prototype);
		let rejected = false;
		try {
			write(child);
		} catch (error) {
			rejected = error instanceof TypeError;
		}
		check(rejected && !Object.hasOwn(child, "value"), "inherited readonly append");
		Object.defineProperty(child, "value", { value: 9 });
		check(
			child.value === 9 && prototype.value === 3,
			"own definition bypasses inherited value",
		);
	},
	transitions() {
		const record = { head: 1 };
		Object.defineProperty(record, "hidden", { value: 2, configurable: true });
		record.tail = 3;
		Object.defineProperty(record, "accessor", { get: () => 4, enumerable: true });
		Object.defineProperty(record, "hidden", { enumerable: true });
		check(Object.values(record).join() === "1,2,3,4", "attribute transition");
		check(Reflect.deleteProperty(record, "hidden"), "configurable deletion");
		Object.defineProperty(record, "hidden", { value: 5 });
		check(keys(record) === "head,tail,accessor,hidden", "delete/re-add order");
		const symbol = Symbol("extra");
		record[symbol] = 6;
		check(
			Object.getOwnPropertyDescriptor(record, "hidden").enumerable === false,
			"overflow attrs",
		);
		check(record[symbol] === 6 && record.accessor === 4, "overflow values");
	},
	growth() {
		class Record {
			#value = { value: 7 };
			head = 1;
			read() {
				return this.#value;
			}
		}
		const record = new Record();
		collect();
		collect();
		const expected = ["head"];
		for (let index = 0; index < 80; index++) {
			const name = "value" + index;
			const value = { index };
			Object.defineProperty(record, name, { value, writable: true, configurable: true });
			expected.push(name);
			collect();
			check(
				record[name] === value && record[name].index === index,
				"retained young field",
			);
		}
		collect();
		for (let index = 0; index < 80; index++)
			check(record["value" + index].index === index, "retained earlier field");
		check(keys(record) === expected.join(), "growth key order");
		check(record.read().value === 7, "private field");
		Object.seal(record);
		check(!Reflect.deleteProperty(record, "value0"), "seal configurable");
		const replacement = { index: 90 };
		record.value0 = replacement;
		collect();
		check(record.value0 === replacement, "sealed writable slot");
		Object.freeze(record);
		collect();
		check(!Reflect.set(record, "value0", null), "frozen slot");
		check(record.read().value === 7 && record.value0 === replacement, "frozen identity");
	},
	reentry() {
		const record = { head: 1 };
		const value = {};
		Object.defineProperty(record, "hidden", {
			get value() {
				Object.defineProperty(record, "accessor", { get: () => 3 });
				collect();
				return value;
			},
		});
		check(keys(record) === "head,accessor,hidden", "reentrant insertion order");
		check(record.hidden === value && record.accessor === 3, "reentrant value");
	},
};

const scenario = process.env.ATTRIBUTED_DATA_CASE;
cases[scenario]();
console.log("PASS " + scenario);
