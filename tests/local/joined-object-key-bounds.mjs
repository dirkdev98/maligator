function assert(condition, message) {
	if (!condition) throw new Error(message);
}
function joinedMissing(value, flag) {
	const record = flag ? { left: value } : { right: value };
	return Object.hasOwn(record, "missing");
}
function joinedDescriptor(value, flag) {
	const record = flag ? { left: value } : { right: value };
	return Object.getOwnPropertyDescriptor(record, "missing");
}
function joinedRead(value, flag) {
	const record = flag ? { left: value } : { right: value };
	return record.missing;
}
function joinedDelete(value, flag) {
	const record = flag ? { left: value } : { right: value };
	return delete record.missing;
}
function possibleNamed(value, flag) {
	const record = flag ? { left: value } : { right: value };
	return Object.hasOwn(record, "left");
}
function possibleSymbol(value, flag) {
	const record = flag ? { [Symbol.iterator]: value } : { [Symbol.toStringTag]: value };
	return Object.hasOwn(record, Symbol.iterator);
}
function mixedSymbolFields(value, flag) {
	const record = flag ? { [Symbol.iterator]: value } : { [Symbol.toStringTag]: value };
	return Object.hasOwn(record, "missing");
}
function nestedJoin(value, first, second) {
	const record = first ? { left: value } : second ? { middle: value } : { right: value };
	return Object.hasOwn(record, Symbol.iterator);
}
function constructorJoin(value, flag) {
	const record = flag ? new RegExp(value) : new String(value);
	return Object.hasOwn(record, Symbol.iterator);
}
function joinedAfterGetter(value, flag, observe) {
	const record = flag ? { left: value } : { right: value };
	const reader = {
		get effect() {
			observe(record);
		},
	};
	reader.effect;
	return Object.hasOwn(record, "missing");
}
function joinedCoercingKey(value, flag, observe) {
	const record = flag ? { left: value } : { right: value };
	const key = {
		[Symbol.toPrimitive](hint) {
			assert(hint === "string", "key hint");
			observe(record);
			return "missing";
		},
	};
	return Object.hasOwn(record, key);
}
function joinedPrototype(value, flag) {
	const prototype = {
		get missing() {
			throw value;
		},
	};
	const record = flag
		? { __proto__: null, left: value }
		: { __proto__: prototype, right: value };
	return record.missing;
}
function joinedLoop(value, flag, limit) {
	let record = {};
	for (let i = 0; i < limit; i++) {
		record = flag ? { left: value } : { right: value };
		if (i > 0) record.missing = value;
	}
	return Object.hasOwn(record, "missing");
}
function joinedOrder(value, flag) {
	const record = flag ? { right: value, left: value } : { middle: value, left: value };
	return Object.keys(record).join(":");
}
function escapedJoin(value, flag, observe) {
	const record = flag ? { left: value } : { right: value };
	observe(record);
	return Object.getOwnPropertyDescriptor(record, "missing").value;
}
function* joinedGenerator(value, flag) {
	const record = flag ? { left: value } : { right: value };
	yield 1;
	return Object.hasOwn(record, "missing");
}
Object.assign(globalThis, {
	joinedKeyProbes: {
		joinedMissing,
		joinedDescriptor,
		joinedRead,
		joinedDelete,
		possibleNamed,
		possibleSymbol,
		mixedSymbolFields,
		nestedJoin,
		constructorJoin,
		joinedAfterGetter,
		joinedCoercingKey,
		joinedPrototype,
		joinedLoop,
		joinedOrder,
		escapedJoin,
		joinedGenerator,
	},
});
const marker = { value: 42 };
let coercions = 0;
const description = {
	toString() {
		coercions++;
		globalThis.gc?.();
		return "pattern";
	},
};
for (const flag of [false, true]) {
	assert(!joinedMissing(marker, flag), "unlisted String stays absent");
	assert(
		joinedDescriptor(marker, flag) === undefined,
		"unlisted descriptor stays absent",
	);
	assert(joinedRead(marker, flag) === undefined, "prototype absence proof");
	assert(joinedDelete(marker, flag), "unlisted delete succeeds");
	assert(possibleNamed(marker, flag) === flag, "possible String stays dynamic");
	assert(possibleSymbol(marker, flag) === flag, "possible Symbol stays dynamic");
	assert(!mixedSymbolFields(marker, flag), "Symbol fields do not introduce String names");
	for (const other of [false, true])
		assert(!nestedJoin(marker, flag, other), "nested key bounds");
	assert(!constructorJoin(description, flag), "constructor domains exclude Symbols");
	const mutate = (record) => {
		record.missing = marker;
		globalThis.gc?.();
	};
	assert(joinedAfterGetter(marker, flag, mutate), "getter mutation is observed");
	assert(joinedCoercingKey(marker, flag, mutate), "coercing key mutation is observed");
	assert(
		escapedJoin(marker, flag, mutate) === marker,
		"escaped descriptor mutation is observed",
	);
	assert(
		!joinedLoop(marker, flag, 0) &&
			!joinedLoop(marker, flag, 1) &&
			joinedLoop(marker, flag, 2),
		"loop joins widen mutated keys",
	);
	assert(
		joinedOrder(marker, flag) === (flag ? "right:left" : "middle:left"),
		"key bounds do not reorder properties",
	);
	const iterator = joinedGenerator(marker, flag);
	assert(iterator.next().value === 1, "joined generator suspends");
	globalThis.gc?.();
	assert(iterator.next().value === false, "joined generator retains key bounds");
	if (flag) assert(joinedPrototype(marker, flag) === undefined, "null prototype read");
	else {
		try {
			joinedPrototype(marker, flag);
			assert(false, "prototype getter was removed");
		} catch (error) {
			assert(error === marker, "prototype getter exception identity");
		}
	}
	try {
		constructorJoin(
			{
				toString() {
					throw marker;
				},
			},
			flag,
		);
		assert(false, "constructor coercion was removed");
	} catch (error) {
		assert(error === marker, "constructor exception identity");
	}
	try {
		joinedAfterGetter(marker, flag, () => {
			throw marker;
		});
		assert(false, "getter exception was removed");
	} catch (error) {
		assert(error === marker, "getter exception identity");
	}
}
assert(coercions === 2, "both constructor branches retain exactly one coercion");
console.log("joined object key bounds semantics passed");
