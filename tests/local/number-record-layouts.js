"use strict";
const mode = process.env.NUMBER_LAYOUT_MODE ?? "update";
const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
function update(record, scale) {
	record.x = record.x * scale + record.y;
	record.y = record.y + record.z * scale;
	record.z = record.z - record.w;
	record.w = record.w * scale;
	return record.x + record.y + record.z + record.w + record.tail;
}
function total(record) {
	return record.x + record.y + record.z + record.w + record.tail;
}
globalThis.updateNumberLayout = update;
globalThis.totalNumberLayout = total;
function make(kind, index) {
	const values = [index + 1, index + 2, index + 3, index + 4, index + 5];
	if (kind === 0)
		return { x: values[0], y: values[1], z: values[2], w: values[3], tail: values[4] };
	if (kind === 1)
		return {
			prefix: 17,
			tail: values[4],
			w: values[3],
			z: values[2],
			y: values[1],
			x: values[0],
		};
	return {
		y: values[1],
		label: "third",
		x: values[0],
		w: values[3],
		tail: values[4],
		z: values[2],
	};
}
function scalar(value) {
	if (Object.is(value, -0)) return "-0";
	return Number.isFinite(value) ? value : String(value);
}
function inspect(record) {
	return [record.x, record.y, record.z, record.w, record.tail].map(scalar);
}
const rows = [];
if (mode === "fallback") {
	for (let kind = 0; kind < 3; kind++) globalThis.updateNumberLayout(make(kind, 1), 1);
	const events = [];
	const record = make(1, 2);
	Object.defineProperty(record, "z", {
		get() {
			events.push("get");
			collectGarbage();
			record.tail = 99;
			return 3;
		},
		set(value) {
			events.push(`set:${value}`);
			collectGarbage();
			record.tail = 100;
		},
	});
	rows.push(
		scalar(globalThis.updateNumberLayout(record, 0.5)),
		events.slice(),
		inspect(record),
	);
	const readonly = make(2, 3);
	Object.defineProperty(readonly, "y", { writable: false });
	try {
		globalThis.updateNumberLayout(readonly, 0.5);
		throw new Error("missing readonly error");
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		rows.push("readonly", inspect(readonly));
	}
	const proxy = new Proxy(make(1, 4), {
		get(target, key) {
			events.push(`get:${String(key)}`);
			collectGarbage();
			return target[key];
		},
		set(target, key, value) {
			events.push(`set:${String(key)}`);
			collectGarbage();
			target[key] = value;
			return true;
		},
	});
	rows.push(scalar(globalThis.updateNumberLayout(proxy, 0.5)), events.slice());
	const inherited = make(2, 5);
	delete inherited.z;
	Object.setPrototypeOf(inherited, { z: 20 });
	rows.push(scalar(globalThis.updateNumberLayout(inherited, 0.5)), inspect(inherited));
	const coercing = make(1, 6);
	coercing.x = {
		valueOf() {
			events.push("coerce");
			collectGarbage();
			coercing.y = 50;
			return 2;
		},
	};
	rows.push(
		scalar(globalThis.updateNumberLayout(coercing, 0.5)),
		inspect(coercing),
		events.slice(),
	);
} else {
	for (let index = 0; index < 18; index++) {
		let record = make(index % 3, index % 4);
		if (mode === "readonly") Object.freeze(record);
		if (mode === "callable")
			Object.assign((record = function holder() {}), make(index % 3, index % 4));
		const result =
			mode === "readonly" || mode === "callable"
				? globalThis.totalNumberLayout(record)
				: globalThis.updateNumberLayout(record, index < 6 ? 1 : index % 2 ? 0.5 : -0);
		rows.push([scalar(result), inspect(record)]);
		collectGarbage();
	}
}
console.log(JSON.stringify(rows));
