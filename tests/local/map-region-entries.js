function update(map, firstKey, secondKey, mutate) {
	const first = map.get(firstKey);
	const second = map.get(secondKey);
	mutate(map, firstKey, secondKey);
	map.set(firstKey, first + 1);
	map.set(secondKey, second + 1);
	return [first, second, map.get(firstKey), map.get(secondKey), map.size];
}
function noop() {}
function runCase(kind) {
	const map = new Map();
	for (let key = 0; key < 40; key++) map.set(key, key);
	const mutations = [
		noop,
		(map, first) => map.delete(first),
		(map, first, second) => {
			map.clear();
			map.set(second, 50);
			map.set(first, 60);
		},
		(map) => {
			for (let key = 0; key < 35; key++) map.delete(key);
			for (let key = 100; key < 1200; key++) map.set(key, key);
		},
		(map, first) => map.set(first, { changed: true }),
		() => {
			if (typeof gc === "function") gc();
		},
	];
	return update(map, 3, kind % 2 ? 3 : 7, mutations[kind >> 1]);
}
const rows = Array.from({ length: 12 }, (_, i) => i).map(runCase);
const symbol = Symbol("key"),
	object = {};
for (const pair of [
	[NaN, NaN],
	[-0, 0],
	[Infinity, -Infinity],
	[1.25, 7.5],
	["x", "y"],
	[1n, 2n],
	[symbol, object],
]) {
	const map = new Map([
		[pair[0], 10],
		[pair[1], 20],
	]);
	rows.push(update(map, pair[0], pair[1], noop));
}
rows.push(update(new Map(), 1, 2, noop));
const map = new Map([
	[
		1,
		{
			valueOf() {
				map.clear();
				return 10;
			},
		},
	],
	[2, 20],
]);
rows.push(update(map, 1, 2, noop));
if (typeof process !== "undefined" && process.env.MAL_MAP_MUTABLE === "mutable") {
	const original = Map.prototype.set;
	let calls = 0;
	const mutable = new Map([
		[1, 10],
		[2, 20],
	]);
	rows.push(
		update(mutable, 1, 2, () => {
			Map.prototype.set = function (key, value) {
				calls++;
				return original.call(this, key, value + 5);
			};
		}),
	);
	Map.prototype.set = original;
	rows.push(calls);
	const getter = new Map([
		[1, 10],
		[2, 20],
	]);
	let loads = 0;
	Object.defineProperty(getter, "set", {
		get() {
			loads++;
			if (loads === 1) getter.clear();
			return original;
		},
	});
	rows.push(update(getter, 1, 2, noop), loads);
	const proxy = new Proxy(new Map(), {});
	try {
		rows.push(update(proxy, 1, 2, noop));
	} catch (error) {
		rows.push(error.name);
	}
}
console.log(JSON.stringify(rows));
