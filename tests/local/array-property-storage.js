const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function collect() {
	if (typeof collectGarbage === "function") collectGarbage();
}

function checkNamedProperties() {
	const first = { name: "birch" };
	const second = { name: "cedar" };
	const values = [first, second];
	values.label = first;
	for (let index = 0; index < 8; index++) values[`early${index}`] = { index };
	collect();
	assert(values.early7.index === 7 && values.label === first, "named field growth");
	const symbol = Symbol("array-metadata");
	values[symbol] = second;
	for (let index = 0; index < 32; index++) values[`field${index}`] = { index };
	values.push(first, second, first);
	collect();
	assert(
		values.length === 5 && values[0] === first && values[4] === first,
		"dense growth",
	);
	assert(values.label === first && values[symbol] === second, "named roots");
	for (let index = 0; index < 32; index++)
		assert(values[`field${index}`].index === index, "dictionary roots");
	delete values.label;
	values.label = second;
	Object.defineProperty(values, "computed", {
		get() {
			return this[1];
		},
		configurable: true,
	});
	collect();
	assert(
		values.computed === second && values.label === second,
		"accessors and replacement",
	);
	const copy = values.concat([second]);
	assert(
		copy.length === 6 && copy[0] === first && copy[5] === second,
		"concat after named properties",
	);
	values[10_000] = first;
	collect();
	assert(
		values.length === 10_001 && values[10_000] === first && values[symbol] === second,
		"sparse transition",
	);
}

function checkPrototypeChanges() {
	const values = [1, 2];
	const prototype = Object.create(Array.prototype);
	prototype.marker = { name: "elm" };
	Object.setPrototypeOf(values, prototype);
	collect();
	assert(values.marker === prototype.marker && values[1] === 2, "deferred prototype");
	values.named = { name: "fir" };
	Object.setPrototypeOf(values, Array.prototype);
	collect();
	assert(
		Object.getPrototypeOf(values) === Array.prototype && values.named.name === "fir",
		"external prototype",
	);
	assert(values.push(3) === 3 && values[2] === 3, "growth after prototype change");
}

function checkDescriptors() {
	const values = [1, 2];
	Object.defineProperty(values, "1", {
		get() {
			return 7;
		},
		configurable: true,
	});
	values.named = { name: "ash" };
	collect();
	assert(
		values[0] === 1 && values[1] === 7 && values.named.name === "ash",
		"indexed accessor",
	);
	const sealed = [3, 4];
	sealed.named = values.named;
	Object.seal(sealed);
	sealed[1] = 5;
	assert(
		sealed[1] === 5 && sealed.named === values.named && Object.isSealed(sealed),
		"sealed storage",
	);
	const frozen = [values.named];
	Object.freeze(frozen);
	collect();
	assert(Object.isFrozen(frozen) && frozen[0].name === "ash", "frozen elements");
}

checkNamedProperties();
checkPrototypeChanges();
checkDescriptors();
console.log("PASS");
