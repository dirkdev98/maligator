const gc = globalThis.__mal_collect_garbage ?? (() => {});

function builtinDateNow(gate) {
	const value = Date.now();
	gate();
	return value;
}
function builtinDateParse(input, gate) {
	const value = Date.parse(input);
	gate();
	return value;
}
function builtinDateUTC(year, month, gate) {
	const value = Date.UTC(year, month);
	gate();
	return value;
}
function builtinObjectIs(left, right, gate) {
	const value = Object.is(left, right);
	gate();
	return value;
}
function builtinObjectHasOwn(input, key, gate) {
	const value = Object.hasOwn(input, key);
	gate();
	return value;
}
function builtinMapHas(input, key, gate) {
	const value = Map.prototype.has.call(input, key);
	gate();
	return value;
}
function builtinMapDelete(input, key, gate) {
	const value = Map.prototype.delete.call(input, key);
	gate();
	return value;
}
function builtinSetHas(input, key, gate) {
	const value = Set.prototype.has.call(input, key);
	gate();
	return value;
}
function builtinSetDelete(input, key, gate) {
	const value = Set.prototype.delete.call(input, key);
	gate();
	return value;
}
function builtinArraySome(input, predicate, gate) {
	const values = [input, , 3];
	const value = values.some(predicate);
	gate();
	return value;
}
function builtinArrayEvery(input, predicate, gate) {
	const values = [input, , 3];
	const value = values.every(predicate);
	gate();
	return value;
}
function builtinArrayFindIndex(input, predicate, gate) {
	const values = [input, , 3];
	const value = values.findIndex(predicate);
	gate();
	return value;
}
function builtinArrayFindLastIndex(input, predicate, gate) {
	const values = [input, , 3];
	const value = values.findLastIndex(predicate);
	gate();
	return value;
}
globalThis.builtinDateNow = builtinDateNow;
globalThis.builtinDateParse = builtinDateParse;
globalThis.builtinDateUTC = builtinDateUTC;
globalThis.builtinObjectIs = builtinObjectIs;
globalThis.builtinObjectHasOwn = builtinObjectHasOwn;
globalThis.builtinMapHas = builtinMapHas;
globalThis.builtinMapDelete = builtinMapDelete;
globalThis.builtinSetHas = builtinSetHas;
globalThis.builtinSetDelete = builtinSetDelete;
globalThis.builtinArraySome = builtinArraySome;
globalThis.builtinArrayEvery = builtinArrayEvery;
globalThis.builtinArrayFindIndex = builtinArrayFindIndex;
globalThis.builtinArrayFindLastIndex = builtinArrayFindLastIndex;

function boxedBuiltinNumber(input, gate, condition) {
	const value = Number(input);
	gate();
	return condition ? value : undefined;
}
function boxedBuiltinDateParse(input, gate, condition) {
	const value = Date.parse(input);
	gate();
	return condition ? value : undefined;
}
function boxedBuiltinHasOwn(input, key, gate, condition) {
	const value = Object.hasOwn(input, key);
	gate();
	return condition ? value : undefined;
}
globalThis.boxedBuiltinNumber = boxedBuiltinNumber;
globalThis.boxedBuiltinDateParse = boxedBuiltinDateParse;
globalThis.boxedBuiltinHasOwn = boxedBuiltinHasOwn;

function predicateNumber(input, gate) {
	const value = +input;
	gate();
	return [
		Number.isNaN(value),
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isSafeInteger(value),
	];
}
function predicateInt32(input, gate) {
	const value = input | 0;
	gate();
	return [
		Number.isNaN(value),
		Number.isFinite(value),
		Number.isInteger(value),
		Number.isSafeInteger(value),
	];
}
function predicateBoxed(input, extra) {
	return Number.isFinite(input, extra());
}
function predicateText(input) {
	const value = String(input);
	return Number.isInteger(value);
}
globalThis.predicateNumber = predicateNumber;
globalThis.predicateInt32 = predicateInt32;
globalThis.predicateBoxed = predicateBoxed;
globalThis.predicateText = predicateText;
for (const input of [
	-0,
	NaN,
	Infinity,
	-Infinity,
	0.25,
	-1,
	2147483648,
	9007199254740991,
	9007199254740992,
]) {
	console.log("predicate-number", String(input), predicateNumber(input, gc).join(","));
	console.log("predicate-int32", String(input), predicateInt32(input, gc).join(","));
}
let predicateCoercions = 0;
const nonCoercible = {
	marker: "retained",
	valueOf() {
		predicateCoercions++;
		throw new Error("unexpected predicate coercion");
	},
};
console.log(
	"predicate-boxed",
	predicateBoxed(nonCoercible, () => {
		gc();
		return nonCoercible.marker;
	}),
	predicateCoercions,
	nonCoercible.marker,
);
for (const input of [undefined, null, "4", true, 7n, Symbol("predicate")])
	console.log("predicate-non-number", predicateBoxed(input, gc));
console.log(
	"predicate-text",
	predicateText({
		toString() {
			gc();
			return "42";
		},
	}),
);
try {
	predicateBoxed(nonCoercible, () => {
		gc();
		throw { marker: "extra-thrown" };
	});
} catch (error) {
	gc();
	console.log("predicate-extra-throw", error.marker, predicateCoercions);
}

for (const condition of [true, false]) {
	for (const input of [-0, NaN, Infinity, "42", undefined, null, 7n]) {
		const order = [];
		const value = boxedBuiltinNumber(
			{
				valueOf() {
					gc();
					order.push("value");
					return input;
				},
			},
			() => {
				gc();
				order.push("gate");
			},
			condition,
		);
		console.log(
			"boxed-builtin-number",
			condition,
			String(value),
			Object.is(value, -0),
			order.join(","),
		);
	}
	for (const input of ["2001-02-03T04:05:06.007Z", "invalid"]) {
		const value = boxedBuiltinDateParse(
			{
				toString() {
					gc();
					return input;
				},
			},
			gc,
			condition,
		);
		console.log("boxed-builtin-date", condition, String(value));
	}
	const object = new Proxy(
		{ field: { marker: "retained" } },
		{
			getOwnPropertyDescriptor(target, key) {
				gc();
				return Object.getOwnPropertyDescriptor(target, key);
			},
		},
	);
	console.log(
		"boxed-builtin-own",
		condition,
		boxedBuiltinHasOwn(
			object,
			{
				toString() {
					gc();
					return "field";
				},
			},
			gc,
			condition,
		),
	);
	let gateCalled = false;
	try {
		boxedBuiltinNumber(
			{
				valueOf() {
					gc();
					throw { marker: "number-thrown" };
				},
			},
			() => {
				gateCalled = true;
			},
			condition,
		);
	} catch (error) {
		gc();
		console.log("boxed-builtin-throw", error.marker, gateCalled);
	}
	try {
		boxedBuiltinNumber(Symbol("reject"), gc, condition);
	} catch (error) {
		gc();
		console.log("boxed-builtin-reject", error instanceof TypeError);
	}
}

const now = builtinDateNow(gc);
console.log("builtin-clock-result", typeof now, Number.isFinite(now), now > 0);
const order = [];
function gate() {
	gc();
	order.push("gate");
}
for (const text of ["2001-02-03T04:05:06.007Z", "invalid"]) {
	order.length = 0;
	const value = builtinDateParse(
		{
			marker: { text },
			toString() {
				gc();
				order.push("string");
				return this.marker.text;
			},
		},
		gate,
	);
	console.log("builtin-date-parse", String(value), order.join(","));
}
order.length = 0;
const utc = builtinDateUTC(
	{
		valueOf() {
			gc();
			order.push("year");
			return 2001;
		},
	},
	{
		valueOf() {
			gc();
			order.push("month");
			return 1;
		},
	},
	gate,
);
console.log("builtin-date-utc", utc, order.join(","));
console.log("builtin-date-invalid", String(builtinDateUTC(Infinity, 0, gc)));
for (const value of [-0, NaN, 1, "text", null, undefined])
	console.log(
		"builtin-object-is",
		builtinObjectIs(value, value, gc),
		builtinObjectIs(value, 0, gc),
	);
const target = { field: { marker: "field" } };
const proxy = new Proxy(target, {
	getOwnPropertyDescriptor(object, key) {
		gc();
		return Object.getOwnPropertyDescriptor(object, key);
	},
});
order.length = 0;
console.log(
	"builtin-own",
	builtinObjectHasOwn(
		proxy,
		{
			[Symbol.toPrimitive]() {
				gc();
				order.push("key");
				return "field";
			},
		},
		gate,
	),
	order.join(","),
);
console.log("builtin-own-missing", builtinObjectHasOwn(proxy, "missing", gc));
for (const family of ["map", "set"]) {
	const key = { marker: family };
	const collection =
		family === "map" ? new Map([[key, { retained: true }]]) : new Set([key]);
	const has = family === "map" ? builtinMapHas : builtinSetHas;
	const remove = family === "map" ? builtinMapDelete : builtinSetDelete;
	console.log(
		"builtin-collection",
		has(collection, key, gc),
		remove(collection, key, gc),
		has(collection, key, gc),
	);
	try {
		has({}, key, gc);
	} catch (error) {
		gc();
		console.log("builtin-collection-reject", error instanceof TypeError);
	}
}
for (const operation of [
	builtinArraySome,
	builtinArrayEvery,
	builtinArrayFindIndex,
	builtinArrayFindLastIndex,
]) {
	const value = operation(
		{ marker: "input" },
		(input) => {
			gc();
			return input === 3;
		},
		gc,
	);
	console.log("builtin-array-result", typeof value, value);
	try {
		operation(
			{ marker: "throw" },
			() => {
				gc();
				throw { marker: "callback-thrown" };
			},
			gc,
		);
	} catch (error) {
		gc();
		console.log("builtin-array-throw", error.marker);
	}
}
for (const operation of [builtinDateParse, builtinDateUTC]) {
	try {
		if (operation === builtinDateParse) operation(Symbol("date"), gc);
		else operation(Symbol("date"), 0, gc);
	} catch (error) {
		gc();
		console.log("builtin-date-reject", error instanceof TypeError);
	}
}
try {
	builtinObjectHasOwn(null, "field", gc);
} catch (error) {
	gc();
	console.log("builtin-own-reject", error instanceof TypeError);
}
try {
	builtinDateParse(
		{
			toString() {
				gc();
				throw { marker: "date-thrown" };
			},
		},
		gc,
	);
} catch (error) {
	gc();
	console.log("builtin-date-throw", error.marker);
}
