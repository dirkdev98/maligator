const events = [];
function assert(value) {
	if (!value) throw new Error("primitive wrapper state invariant");
}
function privateBoolean(x) {
	const box = new Boolean(x);
	const alias = box;
	box.note = x;
	alias.note = 7;
	delete box.note;
	box.other = 13;
	return (box.note === undefined) + alias.other;
}
globalThis.privateBoolean = privateBoolean;
function escapingBoolean(x) {
	const box = new Boolean(x);
	box.first = x;
	box.second = 2;
	delete box.first;
	box.first = 3;
	return box;
}
globalThis.escapingBoolean = escapingBoolean;
function escapingNumber(x) {
	const box = new Number(+x);
	box.note = 1;
	delete box.note;
	box.value = x;
	return box;
}
globalThis.escapingNumber = escapingNumber;
function escapingBigInt(x) {
	const box = Object(BigInt(x));
	box.note = x;
	box.note = 2;
	return box;
}
globalThis.escapingBigInt = escapingBigInt;
function escapingSymbol(x) {
	const box = Object(Symbol.for(x));
	box.note = x;
	delete box.note;
	box.note = 4;
	return box;
}
globalThis.escapingSymbol = escapingSymbol;

function privateNumber(x) {
	const box = new Number(x);
	box.note = 1;
	box.note = 2;
	delete box.note;
	box.other = 13;
	return (box.note === undefined) + box.other;
}
function privateString(x) {
	const box = new String(x);
	box.note = 1;
	box.note = 2;
	delete box.note;
	box.other = 13;
	return (box.note === undefined) + box.other;
}
function escapingNumberDynamic(x) {
	const box = new Number(x);
	box.note = 1;
	delete box.note;
	box.other = 13;
	return box;
}
function escapingString(x) {
	const box = new String(x);
	box.note = 1;
	delete box.note;
	box.other = 13;
	return box;
}
globalThis.privateNumber = privateNumber;
globalThis.privateString = privateString;
globalThis.escapingNumberDynamic = escapingNumberDynamic;
globalThis.escapingString = escapingString;

for (const [privateState, escapingState, prototype, hint, primitive] of [
	[
		globalThis.privateNumber,
		globalThis.escapingNumberDynamic,
		Number.prototype,
		"number",
		-0,
	],
	[
		globalThis.privateString,
		globalThis.escapingString,
		String.prototype,
		"string",
		"\ud83d\ude00x",
	],
]) {
	let conversions = 0;
	const input = {
		[Symbol.toPrimitive](actualHint) {
			assert(actualHint === hint);
			conversions++;
			return primitive;
		},
	};
	assert(privateState(input) === 14 && conversions === 1);
	const first = escapingState(input);
	const second = escapingState(input);
	assert(conversions === 3 && first !== second);
	assert(Object.getPrototypeOf(first) === prototype);
	assert(Object.is(prototype.valueOf.call(first), primitive));
	assert(first.other === 13 && !Object.hasOwn(first, "note"));
	const descriptor = Object.getOwnPropertyDescriptor(first, "other");
	assert(
		descriptor.value === 13 &&
			descriptor.writable &&
			descriptor.enumerable &&
			descriptor.configurable,
	);
	if (hint === "string") {
		assert(first.length === 3 && first[0] === "\ud83d" && first[1] === "\ude00");
		assert(Object.keys(first).join() === "0,1,2,other");
		const index = Object.getOwnPropertyDescriptor(first, "0");
		assert(
			index.value === "\ud83d" &&
				!index.writable &&
				index.enumerable &&
				!index.configurable,
		);
	}
	for (const invoke of [privateState, escapingState]) {
		const sentinel = {};
		try {
			invoke({
				[Symbol.toPrimitive]() {
					throw sentinel;
				},
			});
			throw new Error("conversion must throw");
		} catch (error) {
			assert(error === sentinel);
		}
		try {
			invoke(Symbol.iterator);
			throw new Error("Symbol conversion must throw");
		} catch (error) {
			assert(error instanceof TypeError);
		}
	}
}
globalThis.protectedStringState = [
	(x) => {
		const box = new String(x);
		box.note = 1;
		delete box.note;
		box[0] = "z";
		return box;
	},
	(x) => {
		const box = new String(x);
		box.note = 1;
		delete box.note;
		box.length = 0;
		return box;
	},
	(x) => {
		const box = new String(x);
		box.note = 1;
		delete box.note;
		delete box[0];
		return box;
	},
	(x) => {
		const box = new String(x);
		box.note = 1;
		delete box.note;
		Object.defineProperty(box, "0", { value: "z" });
		return box;
	},
];
for (const invoke of globalThis.protectedStringState) {
	try {
		invoke("abc");
		throw new Error("String exotic state must reject mutation");
	} catch (error) {
		assert(error instanceof TypeError);
	}
}
for (const [prototype, invoke] of [
	[Number.prototype, globalThis.privateNumber],
	[String.prototype, globalThis.privateString],
]) {
	if (Object.isFrozen(prototype)) continue;
	Object.defineProperty(prototype, "note", {
		set(value) {
			this.captured = value;
		},
		get() {
			return this.captured + 1;
		},
		configurable: true,
	});
	try {
		assert(invoke(17) === 13);
	} finally {
		delete prototype.note;
	}
}

const uncoercible = {
	[Symbol.toPrimitive]() {
		throw new Error("Boolean must not coerce objects");
	},
};
for (const input of [false, 0, -0, NaN, "", 1, "x", null, undefined, uncoercible]) {
	assert(globalThis.privateBoolean(input) === 14);
	const first = globalThis.escapingBoolean(input);
	const second = globalThis.escapingBoolean(input);
	assert(first !== second);
	assert(Boolean.prototype.valueOf.call(first) === !!input);
	assert(Object.getPrototypeOf(first) === Boolean.prototype);
	assert(Object.keys(first).join(":") === "second:first");
	const descriptor = Object.getOwnPropertyDescriptor(first, "first");
	assert(
		descriptor.value === 3 &&
			descriptor.writable &&
			descriptor.enumerable &&
			descriptor.configurable,
	);
}
for (const input of [-0, NaN, Infinity, 4]) {
	const box = globalThis.escapingNumber(input);
	assert(Object.is(Number.prototype.valueOf.call(box), input));
	assert(Object.is(box.value, input));
	assert(!Object.hasOwn(box, "note"));
}
const big = globalThis.escapingBigInt("9007199254740993");
assert(BigInt.prototype.valueOf.call(big) === 9007199254740993n && big.note === 2);
const symbol = globalThis.escapingSymbol("wrapper-state");
assert(
	Symbol.prototype.valueOf.call(symbol) === Symbol.for("wrapper-state") &&
		symbol.note === 4,
);

function numberCoercion(x) {
	const box = new Number(x);
	box.note = events.push("store");
	return box.note;
}
globalThis.numberCoercion = numberCoercion;
assert(
	globalThis.numberCoercion({
		valueOf() {
			events.push("coerce");
			return 13;
		},
	}) === 2,
);
assert(events.join(":") === "coerce:store");
const target = {};
const original = Object(target);
original.note = 3;
assert(original === target && target.note === 3);
const string = Object("abc");
assert(!Reflect.set(string, "0", "z"));
assert(string[0] === "a" && string.length === 3);

const alternatePrototype = {};
const targetConstructor = new Proxy(function () {}, {
	get(target, key, receiver) {
		if (key === "prototype") {
			events.push("newTarget");
			return alternatePrototype;
		}
		return Reflect.get(target, key, receiver);
	},
});
const alternate = Reflect.construct(Boolean, [false], targetConstructor);
alternate.note = 6;
assert(Object.getPrototypeOf(alternate) === alternatePrototype);
assert(Boolean.prototype.valueOf.call(alternate) === false && alternate.note === 6);
assert(events.filter((value) => value === "newTarget").length === 1);

function* suspended(x) {
	const box = new Boolean(x);
	box.note = 1;
	delete box.note;
	box.note = 2;
	yield box;
	return box.note;
}
const iterator = suspended(false);
const yielded = iterator.next().value;
assert(Boolean.prototype.valueOf.call(yielded) === false && yielded.note === 2);
yielded.note = 9;
assert(iterator.next().value === 9);

const readonly = new Boolean(false);
Object.defineProperty(readonly, "note", { value: 8 });
try {
	delete readonly.note;
	throw new Error("deleted a nonconfigurable property");
} catch (error) {
	assert(error instanceof TypeError && readonly.note === 8);
}
if (!Object.isFrozen(Boolean.prototype)) {
	Object.defineProperty(Boolean.prototype, "note", {
		set(value) {
			this.captured = value;
		},
		get() {
			return this.captured + 1;
		},
		configurable: true,
	});
	try {
		assert(globalThis.privateBoolean(3) === 13);
	} finally {
		delete Boolean.prototype.note;
	}
}
console.log("primitive wrapper state PASS");
