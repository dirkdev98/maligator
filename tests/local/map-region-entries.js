const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});

function check(condition, message) {
	if (!condition) throw new Error(message);
}

function updateReferences(map, firstKey, secondKey, nextFirst, nextSecond, mutate) {
	const first = map.get(firstKey);
	const second = map.get(secondKey);
	mutate(map, firstKey, secondKey);
	map.set(firstKey, nextFirst);
	map.set(secondKey, nextSecond);
	return [first, second, map.get(firstKey), map.get(secondKey)];
}

function updateAfterHandler(map, firstKey, secondKey, nextFirst, nextSecond, mutate) {
	try {
		mutate(null);
	} catch (error) {
		check(Object.is(error, firstKey), "handler completion");
	}
	const first = map.get(firstKey);
	const second = map.get(secondKey);
	mutate(map, firstKey, secondKey);
	map.set(firstKey, nextFirst);
	map.set(secondKey, nextSecond);
	return [first, second, map.get(firstKey), map.get(secondKey)];
}

function references(withHandler) {
	const symbol = Symbol("entry"),
		object = {};
	const keys = [
		["first-".repeat(20), "second-".repeat(20)],
		[BigInt("123456789012345678901234567890"), BigInt("123456789012345678901234567891")],
		[symbol, object],
		[undefined, null],
		[true, false],
		[NaN, -0],
		[object, object],
	];
	let count = 0;
	for (const [firstKey, secondKey] of keys) {
		for (let mutation = 0; mutation < 5; mutation++) {
			const same = Object.is(firstKey, secondKey);
			const oldFirst = { label: "old-first" },
				oldSecond = { label: "old-second" };
			const storedKey = (key) =>
				typeof key === "string"
					? `prefix${key}`.slice(6)
					: typeof key === "bigint"
						? BigInt(key.toString())
						: key;
			const map = new Map([
				[storedKey(firstKey), oldFirst],
				[storedKey(secondKey), oldSecond],
			]);
			collectGarbage();
			const nextFirst = { label: "new-first" },
				nextSecond = { label: "new-second" };
			const mutate = (target) => {
				if (target === null) throw firstKey;
				if (mutation === 1) target.delete(firstKey);
				if (mutation === 2) {
					target.clear();
					target.set(secondKey, oldSecond);
					target.set(firstKey, oldFirst);
				}
				if (mutation === 3) {
					for (let key = 0; key < 96; key++) target.set(`temporary-${key}`, key);
					for (let key = 0; key < 90; key++) target.delete(`temporary-${key}`);
					for (let key = 100; key < 140; key++) target.set(key, { key });
				}
				if (mutation === 4) target.set(firstKey, undefined);
				collectGarbage();
			};
			const update = withHandler ? updateAfterHandler : updateReferences;
			const result = update(map, firstKey, secondKey, nextFirst, nextSecond, mutate);
			check(
				result[0] === (same ? oldSecond : oldFirst) && result[1] === oldSecond,
				"retained values",
			);
			check(
				result[2] === (same ? nextSecond : nextFirst) && result[3] === nextSecond,
				"reference updates",
			);
			collectGarbage();
			check(
				map.get(firstKey).label === (same ? "new-second" : "new-first"),
				"new value root",
			);
			check(map.get(secondKey).label === "new-second", "second value root");
			count++;
		}
	}
	return count;
}

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
		collectGarbage,
	];
	return update(map, 3, kind % 2 ? 3 : 7, mutations[kind >> 1]);
}
function updateAcrossControl(map, firstKey, secondKey, mutate, branch) {
	let first = "unread-first",
		second = "unread-second";
	try {
		first = map.get(firstKey);
		second = map.get(secondKey);
		if (branch) mutate(map);
		else collectGarbage();
	} catch (error) {
		check(error && error.message === "lookup", "original completion");
		collectGarbage();
	}
	const firstResult = map.set(firstKey, { previous: first });
	const secondResult = map.set(secondKey, { previous: second });
	return [first, second, firstResult === map, secondResult === map];
}

function updateLoopHints(maps, keys, skip, mutate) {
	const rows = [];
	for (let index = 0; index < maps.length; index++) {
		const map = maps[index],
			firstKey = keys[index][0],
			secondKey = keys[index][1];
		let first = -1,
			second = -2;
		if (!skip[index]) {
			first = map.get(firstKey);
			second = map.get(secondKey);
		}
		mutate(map, index);
		map.set(firstKey, first + 1);
		map.set(secondKey, second + 2);
		rows.push([map.get(firstKey), map.get(secondKey), map.size]);
	}
	return rows;
}

function controlFlow() {
	const rows = [];
	const firstKey = Symbol("first"),
		secondKey = {};
	for (let mutation = 0; mutation < 5; mutation++) {
		const map = new Map([
			[firstKey, 10],
			[secondKey, 20],
		]);
		rows.push(
			updateAcrossControl(
				map,
				firstKey,
				secondKey,
				(target) => {
					if (mutation === 1) target.delete(firstKey);
					if (mutation === 2) {
						target.clear();
						target.set(secondKey, 80);
						target.set(firstKey, 90);
					}
					if (mutation === 3) {
						for (let key = 0; key < 100; key++) target.set(key, key);
						for (let key = 0; key < 95; key++) target.delete(key);
					}
					if (mutation === 4) {
						const inner = new Map([
							[firstKey, 30],
							[secondKey, 40],
						]);
						const nested = updateAcrossControl(inner, firstKey, secondKey, noop, false);
						check(nested[0] === 30 && nested[1] === 40, "reentrant activation");
						throw new Error("lookup");
					}
					collectGarbage();
				},
				true,
			),
		);
		check(
			map.get(firstKey).previous === 10 && map.get(secondKey).previous === 20,
			"handler values",
		);
	}
	let reads = 0;
	const throwing = new Map([
		[firstKey, 10],
		[secondKey, 20],
	]);
	Object.defineProperty(throwing, "get", {
		value(key) {
			if (++reads === 2) throw new Error("lookup");
			collectGarbage();
			return Map.prototype.get.call(this, key);
		},
	});
	rows.push(updateAcrossControl(throwing, firstKey, secondKey, noop, false), reads);
	check(
		Map.prototype.get.call(throwing, secondKey).previous === "unread-second",
		"throw preserves destination",
	);
	const maps = [
		new Map(),
		new Map([
			["a", 10],
			["b", 20],
		]),
		new Map([
			["a", 30],
			["b", 40],
		]),
		new Map([
			["c", 30],
			["d", 40],
		]),
		new Map([
			["z", 50],
			["b", 60],
		]),
		new Map([
			["a", 30],
			["b", 40],
		]),
		new Map([
			["b", 70],
			["a", 80],
		]),
	];
	let genericReads = 0;
	Object.defineProperty(maps[5], "get", {
		value() {
			genericReads++;
			return 77;
		},
	});
	rows.push(
		updateLoopHints(
			maps,
			[
				["a", "b"],
				["a", "b"],
				["a", "b"],
				["c", "d"],
				["a", "b"],
				["a", "b"],
				["a", "b"],
			],
			[true, false, true, true, true, false, false],
			(map, index) => {
				if (index === 6) {
					map.clear();
					map.set("a", 90);
					map.set("b", 100);
				}
				collectGarbage();
			},
		),
	);
	check(
		genericReads === 4 &&
			Map.prototype.get.call(maps[5], "a") === 78 &&
			Map.prototype.get.call(maps[5], "b") === 79,
		"generic result with prior hint",
	);
	const fake = {
		get() {
			return 7;
		},
		set(key, value) {
			this[key] = value;
			return 42;
		},
	};
	rows.push(updateAcrossControl(fake, "a", "b", noop, false));
	const marker = { label: "setter" };
	let sets = 0;
	Object.defineProperty(fake, "set", {
		value() {
			sets++;
			throw marker;
		},
	});
	try {
		updateAcrossControl(fake, "a", "b", noop, false);
		throw new Error("missed throw");
	} catch (error) {
		check(error === marker && sets === 1, "setter abrupt without replay");
	}
	return rows;
}

const mode = globalThis.process?.env.MAL_MAP_REGION_MODE;
if (mode === "control") {
	console.log(JSON.stringify(controlFlow()));
} else if (mode === "references" || mode === "handler") {
	console.log(mode, references(mode === "handler"));
} else {
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
}
