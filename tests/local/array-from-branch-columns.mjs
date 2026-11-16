const OriginalArray = Array;
const originalFrom = Array.from;
const originalIterator = Array.prototype[Symbol.iterator];
const scenario = process.env.ARRAY_BRANCH_CASE ?? "left";
let shared = [];
let observed = 0;
function observe() {
	for (const row of shared) observed += row.point.x;
}
function update(flag) {
	const rows = flag
		? Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }))
		: Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }));
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			const point = row.point;
			point.x += row.delta;
			total += point.x;
		}
		observe();
	}
	return total;
}
function single() {
	const rows = Array.from({ length: 32 }, (_, id) => ({
		point: { x: id * 0.5 },
		delta: id & 3,
	}));
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
	}
	return total;
}
function published(flag) {
	const rows = flag
		? Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }))
		: Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }));
	const alias = rows;
	shared = alias;
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
		observe();
	}
	return total;
}
function sequential(flag) {
	const first = Array.from({ length: 32 }, (_, id) => ({
		point: { x: id * 0.5 },
		delta: id & 3,
	}));
	const second = Array.from({ length: 32 }, (_, id) => ({
		point: { x: id * 0.5 },
		delta: id & 3,
	}));
	const rows = flag ? first : second;
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
		observe();
	}
	return total;
}
function external(flag) {
	const rows = flag
		? Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }))
		: shared;
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
		observe();
	}
	return total;
}
function twice(flag) {
	const rows = flag
		? Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }))
		: Array.from({ length: 32 }, (_, id) => ({ point: { x: id * 0.5 }, delta: id & 3 }));
	let total = 0;
	for (let round = 0; round < 12; round++) {
		for (const row of rows) {
			row.point.x += row.delta;
			total += row.point.x;
		}
	}
	for (const row of rows) total += row.point.x;
	return total;
}
let result, caught;
try {
	if (scenario === "single") result = single();
	else if (scenario === "published") result = published(true);
	else if (scenario === "second-traversal") result = twice(false);
	else if (scenario === "external") {
		shared = originalFrom.call(OriginalArray, { length: 32 }, (_, id) => ({
			point: { x: id * 0.5 },
			delta: id & 3,
		}));
		result = external(false);
	} else {
		if (scenario === "global")
			globalThis.Array = {
				from(source, map) {
					shared = originalFrom.call(OriginalArray, source, map);
					return shared;
				},
			};
		if (scenario === "method")
			Array.from = function (source, map) {
				shared = originalFrom.call(OriginalArray, source, map);
				return shared;
			};
		if (scenario === "subclass")
			globalThis.Array = class extends OriginalArray {
				constructor(...args) {
					super(...args);
					shared = this;
				}
			};
		if (scenario === "sequential-left" || scenario === "sequential-right") {
			Array.from = function (source, map) {
				shared = originalFrom.call(OriginalArray, source, map);
				Array.from = originalFrom;
				return shared;
			};
			result = sequential(scenario === "sequential-left");
		} else {
			if (scenario === "iterator")
				Array.prototype[Symbol.iterator] = function () {
					shared = this;
					return originalIterator.call(this);
				};
			if (scenario === "abrupt")
				Array.from = function () {
					throw { token: "producer stopped" };
				};
			result = update(scenario !== "right");
		}
	}
} catch (error) {
	caught = error.token;
} finally {
	globalThis.Array = OriginalArray;
	Array.from = originalFrom;
	Array.prototype[Symbol.iterator] = originalIterator;
}
console.log(JSON.stringify({ result, observed, caught }));
