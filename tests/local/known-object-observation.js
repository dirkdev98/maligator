"use strict";
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const rows = [];
const events = [];
function collect() {
	if (typeof gc === "function") gc();
}
function freezeRead(input, freeze) {
	const record = { x: +input, y: 2 };
	if (freeze) Object.freeze(record);
	collect();
	return record.x + record.y;
}
function freezeWrite(input, freeze) {
	const record = { x: +input, y: 2 };
	if (freeze) Object.freeze(record);
	record.y = 7;
	return record.x + record.y;
}
function sealRead(input, seal) {
	const record = { x: +input, y: 2 };
	if (seal) Object.seal(record);
	record.y = 7;
	collect();
	return record.x + record.y;
}
function descriptorRead(input, change, descriptor) {
	const record = { x: +input, y: 2 };
	const alias = record;
	if (change) Object.defineProperty(record, "x", descriptor);
	record.x = record.x + 1;
	collect();
	return [record.x, alias.x, record.y];
}
function assignRead(input, change, source) {
	const record = { x: +input, y: 2 };
	if (change) Object.assign(record, source);
	collect();
	return [record.x, record.y];
}
function builtinAlias(input, freeze) {
	const record = { x: input, y: 2 };
	const alias = record;
	let result = record;
	if (freeze) result = Object.freeze(record);
	collect();
	return [result === alias, result.x, record.y, Object.isFrozen(result)];
}
function mixedFreeze(fallback, choose, freeze) {
	const record = choose ? { x: 11, y: 2 } : fallback;
	if (freeze) Object.freeze(record);
	collect();
	return [record.x, record.y];
}
globalThis.builtinRecordConsumers = {
	freezeRead,
	freezeWrite,
	sealRead,
	descriptorRead,
	assignRead,
	builtinAlias,
	mixedFreeze,
};
const selected = globalThis.builtinRecordConsumers;
const mode = process.env.OBJECT_OBSERVER_CASE ?? "semantics";
const isolated = selected[mode];
if (mode !== "semantics") {
	for (let i = 0; i < 20; i++) rows.push(isolated(i, (i & 1) !== 0));
} else {
	for (const flag of [false, true]) {
		rows.push(selected.freezeRead(3, flag), selected.sealRead(3, flag));
		try {
			rows.push(selected.freezeWrite(3, flag));
		} catch (error) {
			rows.push(error.name);
		}
		rows.push(selected.builtinAlias({ label: "retained" }, flag));
		let current = 20;
		rows.push(
			selected.descriptorRead(3, flag, {
				get() {
					events.push("get");
					collect();
					return current;
				},
				set(value) {
					events.push("set:" + value);
					current = value + 10;
					collect();
				},
				configurable: true,
			}),
		);
		rows.push(
			selected.assignRead(3, flag, {
				get x() {
					events.push("source");
					rows.push(selected.freezeRead(8, true));
					collect();
					return { label: "assigned" };
				},
				y: "changed",
			}),
		);
	}
	for (const name of ["descriptorRead", "assignRead"]) {
		try {
			selected[name](1, true, {
				get get() {
					collect();
					throw new RangeError("descriptor");
				},
				get x() {
					collect();
					throw new TypeError("source");
				},
			});
		} catch (error) {
			rows.push(error.name);
		}
	}
	for (const choose of [false, true]) {
		const proxy = new Proxy(
			{ x: 30, y: 4 },
			{
				preventExtensions(target) {
					events.push("prevent");
					return Reflect.preventExtensions(target);
				},
				ownKeys(target) {
					events.push("keys");
					return Reflect.ownKeys(target);
				},
				getOwnPropertyDescriptor(target, key) {
					events.push("desc:" + key);
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
				defineProperty(target, key, descriptor) {
					events.push("define:" + key);
					collect();
					return Reflect.defineProperty(target, key, descriptor);
				},
				get(target, key) {
					events.push("read:" + key);
					return target[key];
				},
			},
		);
		rows.push(selected.mixedFreeze(proxy, choose, true));
	}
	if (process.env.MAL_PRIMORDIALS !== "locked") {
		const original = Object.freeze;
		let retained;
		Object.freeze = (record) => {
			retained = record;
			record.x = "mutated";
			collect();
			return { x: "replacement" };
		};
		rows.push(selected.freezeRead(3, true), selected.builtinAlias(3, true));
		rows.push(retained.x);
		Object.freeze = original;
	}
	rows.push(events);
}
console.log(JSON.stringify(rows));
