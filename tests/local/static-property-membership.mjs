function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function ownPresence(value) {
	const record = { present: value };
	return "present" in record;
}

function accessorPresence(value) {
	const record = {
		get present() {
			throw value;
		},
	};
	return "present" in record;
}

function arrayLengthPresence(value, observe) {
	const array = [value];
	observe(array);
	return "length" in array;
}

function deletedPresence(value) {
	const record = { present: value };
	delete record.present;
	return "present" in record;
}

function coercedPresence(value, observe) {
	const record = { present: value };
	const key = {
		[Symbol.toPrimitive](hint) {
			assert(hint === "string", "membership key hint");
			observe(record);
			return "present";
		},
	};
	return key in record;
}

function* privateGenerator(value) {
	const record = { present: value };
	yield 1;
	return "present" in record;
}

function* escapingGenerator(value) {
	const record = { present: value };
	yield record;
	return "present" in record;
}

async function privateAsync(value) {
	const record = { present: value };
	await 1;
	return "present" in record;
}

async function escapingAsync(value, observe) {
	const record = { present: value };
	await observe(record);
	return "present" in record;
}

async function* privateAsyncGenerator(value) {
	const record = { present: value };
	yield 1;
	return "present" in record;
}

async function* escapingAsyncGenerator(value) {
	const record = { present: value };
	yield record;
	return "present" in record;
}

globalThis.membershipProbes = {
	ownPresence,
	accessorPresence,
	arrayLengthPresence,
	deletedPresence,
	coercedPresence,
	privateGenerator,
	escapingGenerator,
	privateAsync,
	escapingAsync,
	privateAsyncGenerator,
	escapingAsyncGenerator,
};

const marker = { value: 42 };
assert(ownPresence(marker) && accessorPresence(marker), "own data and accessor presence");
assert(1 in { 1: marker } && 1n in { 1: marker }, "numeric keys");
assert((-0) in { 0: marker } && true in { true: marker }, "converted primitive keys");
assert(null in { null: marker } && undefined in { undefined: marker }, "nullish keys");
assert(1 in [, marker] && !(0 in [, marker]), "Array holes");
const symbol = Symbol("own");
assert(symbol in { [symbol]: marker }, "Symbol identity");
assert(Symbol.iterator in { [Symbol.iterator]: marker }, "well-known Symbol key");
assert(!("missing" in { __proto__: null }), "null prototype absence");

const order = [];
const left = () => {
	order.push("left");
	return "present";
};
const right = () => {
	order.push("right");
	return marker;
};
assert(left() in { present: right() }, "effectful operands");
assert(order.join(",") === "left,right", "operand evaluation order");

let conversions = 0;
assert(
	!coercedPresence(marker, (record) => {
		conversions++;
		delete record.present;
		globalThis.gc?.();
	}),
	"key conversion before presence",
);
assert(conversions === 1, "single key conversion");
try {
	coercedPresence(marker, () => {
		throw marker;
	});
	assert(false, "throwing key accepted");
} catch (error) {
	assert(error === marker, "key exception identity");
}

for (const value of [null, undefined, 1, false, 1n, Symbol.iterator, "text"]) {
	const key = {
		[Symbol.toPrimitive]() {
			conversions++;
			return "present";
		},
	};
	try {
		key in value;
		assert(false, "primitive receiver accepted");
	} catch (error) {
		assert(error instanceof TypeError, "primitive receiver throws first");
	}
}
assert(conversions === 1, "receiver check precedes key conversion");

let traps = 0;
const proxy = new Proxy(
	{ present: marker },
	{
		has(_target, key) {
			assert(key === "present", "Proxy key");
			traps++;
			return false;
		},
	},
);
assert(!("present" in proxy) && traps === 1, "Proxy has trap");
const throwingProxy = new Proxy(
	{},
	{
		has() {
			throw marker;
		},
	},
);
try {
	"present" in throwingProxy;
	assert(false, "throwing Proxy accepted");
} catch (error) {
	assert(error === marker, "Proxy exception identity");
}
assert(
	arrayLengthPresence(marker, (array) => {
		array.length = 0;
		Object.setPrototypeOf(array, throwingProxy);
		globalThis.gc?.();
	}),
	"genuine Array length survives mutation and prototype replacement",
);

if (process.env.MAL_PRIMORDIALS === "mutable") {
	Object.prototype.present = 1;
	try {
		assert(deletedPresence(marker), "deleted own property can be inherited");
	} finally {
		delete Object.prototype.present;
	}
}
assert(!deletedPresence(marker), "deleted property absence");

const generator = privateGenerator(marker);
assert(generator.next().value === 1, "private generator yields");
globalThis.gc?.();
assert(generator.next().value === true, "private generator presence");
const escaping = escapingGenerator(marker);
delete escaping.next().value.present;
globalThis.gc?.();
assert(escaping.next().value === false, "yielded record mutation");
assert(await privateAsync(marker), "private async presence");
assert(
	!(await escapingAsync(marker, async (record) => {
		delete record.present;
		globalThis.gc?.();
	})),
	"async escaped record mutation",
);
const asyncGenerator = privateAsyncGenerator(marker);
assert((await asyncGenerator.next()).value === 1, "private async generator yields");
globalThis.gc?.();
assert((await asyncGenerator.next()).value === true, "private async generator presence");
const asyncEscaping = escapingAsyncGenerator(marker);
delete (await asyncEscaping.next()).value.present;
globalThis.gc?.();
assert((await asyncEscaping.next()).value === false, "async yielded record mutation");

function symbolRead(value, description) {
	const key = Symbol(description);
	const record = { [key]: value };
	return record[key];
}

function symbolPresence(value, description) {
	const key = Symbol(description);
	const record = { [key]: value };
	return key in record;
}

function symbolDescriptor(value, description) {
	const key = Symbol(description);
	const record = { [key]: value };
	return Object.getOwnPropertyDescriptor(record, key).value;
}

function unknownRegistryKeys(description, value) {
	const key = Symbol.for(description),
		other = Symbol.for(description);
	const record = { [key]: value };
	return record[other];
}

function shadowedSymbol(Symbol, value) {
	const key = Symbol();
	const record = { [key]: value };
	return record[key];
}

function symbolLoop(value, limit) {
	let previous;
	let result = "";
	for (let i = 0; i < limit; i++) {
		const key = Symbol("same");
		const record = previous ?? { [key]: value };
		result += key in record ? "1" : "0";
		previous = record;
	}
	return result;
}

function* privateSymbolGenerator(value) {
	const key = Symbol("key");
	const record = { [key]: value };
	yield 1;
	return record[key];
}

async function* escapingSymbolGenerator(value) {
	const key = Symbol("key");
	const record = { [key]: value };
	yield { record, key };
	return record[key];
}

Object.assign(globalThis.membershipProbes, {
	symbolRead,
	symbolPresence,
	symbolDescriptor,
	unknownRegistryKeys,
	shadowedSymbol,
	symbolLoop,
	privateSymbolGenerator,
	escapingSymbolGenerator,
});

let descriptions = 0;
const description = {
	[Symbol.toPrimitive](hint) {
		assert(hint === "string", "Symbol description hint");
		descriptions++;
		globalThis.gc?.();
		return "key";
	},
};
assert(symbolRead(marker, description) === marker, "Symbol data read");
assert(symbolPresence(marker, description), "Symbol own presence");
assert(symbolDescriptor(marker, description) === marker, "Symbol descriptor value");
assert(descriptions === 3, "Symbol construction retains description effects");
const accessorKey = Symbol("accessor");
const symbolAccessor = {
	get [accessorKey]() {
		throw marker;
	},
};
assert(
	accessorKey in symbolAccessor,
	"Symbol accessor presence does not invoke the getter",
);
assert(
	typeof Object.getOwnPropertyDescriptor(symbolAccessor, accessorKey).get === "function",
	"Symbol accessor descriptor",
);
try {
	symbolAccessor[accessorKey];
	assert(false, "Symbol getter did not run");
} catch (error) {
	assert(error === marker, "Symbol getter exception identity");
}
try {
	symbolRead(marker, {
		toString() {
			throw marker;
		},
	});
	assert(false, "throwing description accepted");
} catch (error) {
	assert(error === marker, "description exception identity");
}
let registryDescriptions = 0;
assert(
	unknownRegistryKeys(
		{
			toString() {
				return `registry-${registryDescriptions++}`;
			},
		},
		marker,
	) === undefined,
	"registry calls can have distinct keys",
);
assert(registryDescriptions === 2, "registry description conversions");
let shadowedConversions = 0;
assert(
	shadowedSymbol(
		() => ({
			[Symbol.toPrimitive]() {
				return `shadowed-${shadowedConversions++}`;
			},
		}),
		marker,
	) === undefined,
	"shadowed Symbol may return a coercing Object",
);
assert(shadowedConversions === 2, "shadowed Symbol key conversions");
assert(
	symbolLoop(marker, 3) === "100",
	"a Symbol allocation site creates a new identity on every iteration",
);
for (const value of [false, marker]) {
	const key = value ? Symbol.iterator : Symbol.toStringTag;
	const record = { [key]: value };
	globalThis.gc?.();
	assert(record[key] === value, "joined Symbol keys retain their own fields");
}
const symbolGenerator = privateSymbolGenerator(marker);
assert(symbolGenerator.next().value === 1, "private Symbol generator yields");
globalThis.gc?.();
assert(symbolGenerator.next().value === marker, "Symbol field survives suspension");
const symbolEscaping = escapingSymbolGenerator(marker);
const yieldedSymbolRecord = (await symbolEscaping.next()).value;
delete yieldedSymbolRecord.record[yieldedSymbolRecord.key];
globalThis.gc?.();
assert(
	(await symbolEscaping.next()).value === undefined,
	"escaped Symbol field mutation",
);

const storedSymbol = globalThis.chooseSymbol ? Symbol.iterator : Symbol.toStringTag;
function cellAndLocalSymbol(value) {
	const local = Symbol("local");
	const record = { [storedSymbol]: value };
	return record[local];
}
globalThis.membershipProbes.cellAndLocalSymbol = cellAndLocalSymbol;
assert(
	cellAndLocalSymbol(marker) === undefined,
	"cell Symbol and local Symbol remain distinct",
);

function cellSymbolRead(value, observe) {
	const record = { [storedSymbol]: value };
	observe();
	return record[storedSymbol];
}

function cellSymbolPresence(value, observe) {
	const record = { [storedSymbol]: value };
	observe();
	return (
		storedSymbol in record &&
		Object.hasOwn(record, storedSymbol) &&
		Reflect.has(record, storedSymbol)
	);
}

function cellSymbolDescriptor(value, observe) {
	const record = { [storedSymbol]: value };
	observe();
	return Object.getOwnPropertyDescriptor(record, storedSymbol).value;
}

function symbolCellFactory(condition) {
	const captured = condition ? Symbol("one") : Symbol("two");
	function capturedCellRead(value, observe) {
		const record = { [captured]: value };
		observe();
		return record[captured];
	}
	return capturedCellRead;
}

let cellDescriptions = 0;
const registryCell = Symbol.for({
	toString() {
		cellDescriptions++;
		return "shared-cell-key";
	},
});
const aliasCell = Symbol.for({
	toString() {
		return "shared-cell-key";
	},
});

function registryCellRead(value, observe) {
	const record = { [registryCell]: value };
	observe();
	return record[registryCell];
}

function aliasedCellRead(value, observe) {
	const record = { [registryCell]: value };
	observe();
	return record[aliasCell];
}

let changingCell = Symbol("before");
function mutableCellRead(value, observe) {
	const record = { [changingCell]: value };
	observe();
	return record[changingCell];
}

let cellConversions = 0;
const coercingCell = {
	toString() {
		return `cell-key-${cellConversions++}`;
	},
};
function coercingCellRead(value, observe) {
	const record = { [coercingCell]: value };
	observe();
	return record[coercingCell];
}

Object.assign(globalThis.membershipProbes, {
	cellSymbolRead,
	cellSymbolPresence,
	cellSymbolDescriptor,
	symbolCellFactory,
	registryCellRead,
	aliasedCellRead,
	mutableCellRead,
	coercingCellRead,
});
const collect = () => globalThis.gc?.();
assert(cellSymbolRead(marker, collect) === marker, "joined cell Symbol field");
assert(cellSymbolPresence(marker, collect), "joined cell Symbol presence");
assert(cellSymbolDescriptor(marker, collect) === marker, "joined cell Symbol descriptor");
for (const condition of [false, true])
	assert(
		symbolCellFactory(condition)(marker, collect) === marker,
		"captured Symbol cell identity stays within each closure instance",
	);
assert(registryCellRead(marker, collect) === marker, "unknown registry cell field");
assert(cellDescriptions === 1, "registry cell retains initialization coercion");
assert(
	aliasedCellRead(marker, collect) === marker,
	"distinct cells can hold the same Symbol",
);
assert(
	mutableCellRead(marker, () => {
		changingCell = Symbol("after");
	}) === undefined,
	"mutable cell changes invalidate key identity",
);
assert(
	coercingCellRead(marker, collect) === undefined,
	"Object cell keys retain conversion",
);
assert(cellConversions === 2, "Object cell converts at each key use");
try {
	cellSymbolRead(marker, () => {
		throw marker;
	});
	assert(false, "callback exception was removed");
} catch (error) {
	assert(error === marker, "forwarded field preserves callback exception identity");
}
let earlyCellCallbacks = 0;
function earlyCellRead(value) {
	const record = { [lateCell]: value };
	earlyCellCallbacks++;
	return record[lateCell];
}
try {
	earlyCellRead(marker);
	assert(false, "uninitialized cell key was accepted");
} catch (error) {
	assert(error instanceof ReferenceError, "cell key retains its TDZ exception");
}
const lateCell = Symbol("late");
assert(earlyCellCallbacks === 0, "TDZ check precedes the callback");
assert(earlyCellRead(marker) === marker, "initialized cell key reads normally");

function absentSymbolDescriptor(value, description) {
	return Object.getOwnPropertyDescriptor({ known: value }, Symbol(description));
}
function absentSymbolOwn(value, description) {
	return Object.hasOwn({ known: value }, Symbol(description));
}
function absentSymbolRead(value, description) {
	const key = Symbol(description);
	return { __proto__: null, known: value }[key];
}
function absentSymbolDelete(value, description) {
	return delete { known: value }[Symbol(description)];
}
function absentArrayProperties(value) {
	const array = Array(value);
	return [
		Object.hasOwn(array, Symbol.iterator),
		Object.hasOwn(array, "missing"),
		Object.getOwnPropertyDescriptor(array, "missing"),
		delete array.missing,
		Reflect.deleteProperty(array, "missing"),
		Object.hasOwn(array, "0"),
		Object.hasOwn(array, "length"),
		Object.getOwnPropertyDescriptor(array, "length").value,
		Symbol.iterator in array,
	];
}
function absentWrapperSymbol(value) {
	return Object.hasOwn(new String(value), Symbol.iterator);
}
function absentRegExpName(value) {
	return Object.hasOwn(new RegExp(value), "missing");
}
Object.assign(globalThis.membershipProbes, {
	absentSymbolDescriptor,
	absentSymbolOwn,
	absentSymbolRead,
	absentSymbolDelete,
	absentArrayProperties,
	absentWrapperSymbol,
	absentRegExpName,
});
let absenceCoercions = 0;
const absentDescription = {
	toString() {
		absenceCoercions++;
		globalThis.gc?.();
		return "absent";
	},
};
assert(
	absentSymbolDescriptor(marker, absentDescription) === undefined,
	"absent Symbol descriptor",
);
assert(!absentSymbolOwn(marker, absentDescription), "absent own Symbol");
assert(
	absentSymbolRead(marker, absentDescription) === undefined,
	"null-prototype absent Symbol",
);
assert(absentSymbolDelete(marker, absentDescription), "absent Symbol delete");
assert(!absentWrapperSymbol(absentDescription), "String wrapper has no own Symbol");
assert(!absentRegExpName(absentDescription), "RegExp unrelated name is absent");
assert(
	absenceCoercions === 6,
	"absence folds preserve all description and constructor coercions",
);
for (const value of [0, 3, "element", marker, null, undefined, Symbol.iterator]) {
	const result = absentArrayProperties(value);
	assert(
		result[0] === false && result[1] === false && result[2] === undefined,
		"Array own-key bounds",
	);
	assert(result[3] && result[4], "Array unrelated deletes succeed");
	assert(
		result[5] === (typeof value !== "number"),
		"Array index presence depends on its argument",
	);
	assert(
		result[6] && result[7] === (typeof value === "number" ? value : 1),
		"Array length stays own",
	);
	assert(result[8], "Array inherits Symbol.iterator");
}
for (const [run, expected] of [
	[
		() =>
			absentSymbolDescriptor(marker, {
				toString() {
					throw marker;
				},
			}),
		marker,
	],
	[() => absentSymbolOwn(marker, Symbol.iterator), TypeError],
	[
		() =>
			absentSymbolDelete(marker, {
				toString() {
					throw marker;
				},
			}),
		marker,
	],
	[
		() =>
			absentWrapperSymbol({
				toString() {
					throw marker;
				},
			}),
		marker,
	],
	[
		() =>
			absentRegExpName({
				toString() {
					throw marker;
				},
			}),
		marker,
	],
	[() => absentArrayProperties(-1), RangeError],
]) {
	try {
		run();
		assert(false, "absence fold removed a required exception");
	} catch (error) {
		assert(
			expected === marker ? error === marker : error instanceof expected,
			"absence exception identity and class",
		);
	}
}
let inheritedTraps = 0;
const symbolPrototype = new Proxy(
	{},
	{
		has(_target, key) {
			assert(key === Symbol.iterator, "prototype has key");
			inheritedTraps++;
			return true;
		},
		get(_target, key) {
			assert(key === Symbol.iterator, "prototype read key");
			inheritedTraps++;
			return marker;
		},
	},
);
const symbolInherited = { __proto__: symbolPrototype, known: marker };
assert(
	!Object.hasOwn(symbolInherited, Symbol.iterator),
	"own absence ignores prototype traps",
);
assert(
	Object.getOwnPropertyDescriptor(symbolInherited, Symbol.iterator) === undefined,
	"own descriptor ignores prototype traps",
);
assert(inheritedTraps === 0, "own queries do not access the prototype");
assert(Symbol.iterator in symbolInherited, "inherited Symbol has trap");
assert(symbolInherited[Symbol.iterator] === marker, "inherited Symbol read trap");
assert(inheritedTraps === 2, "inherited observations preserve Proxy traps");
let absentDeleteTraps = 0;
const deleteProxy = new Proxy(
	{},
	{
		deleteProperty() {
			absentDeleteTraps++;
			return false;
		},
	},
);
assert(
	!Reflect.deleteProperty(deleteProxy, "missing"),
	"Proxy delete result remains observable",
);
assert(absentDeleteTraps === 1, "Proxy delete trap remains observable");
console.log("static property membership semantics passed");
