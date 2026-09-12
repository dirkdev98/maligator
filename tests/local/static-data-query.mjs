function includes(value, from) {
	return [
		"foo",
		"bar",
		null,
		undefined,
		false,
		true,
		NaN,
		-0,
		2.5,
		5n,
		,
		12,
		13,
		14,
		15,
		16,
		17,
		18,
	].includes(value, from);
}
function own(key) {
	return { 0: 1, a: [1, { b: false }], undefined: 2 }.hasOwnProperty(key);
}
for (const value of ["foo", "missing", undefined, NaN, 0, 5n, {}, Symbol()]) {
	for (const from of [undefined, -Infinity, Infinity, -4, -0, 2.9, "1", null])
		console.log(includes(value, from));
}
for (const key of [0, -0, 0n, "0", "a", undefined, null, Symbol(), "toString"])
	console.log(own(key));
let conversions = 0;
console.log(
	own({
		[Symbol.toPrimitive](hint) {
			conversions++;
			console.log(hint);
			return "a";
		},
	}),
	conversions,
);
console.log(
	includes(18, {
		valueOf() {
			conversions++;
			return -1;
		},
	}),
	conversions,
);
for (const from of [
	1n,
	Symbol(),
	{
		valueOf() {
			throw new Error("coercion");
		},
	},
]) {
	try {
		includes("foo", from);
	} catch (error) {
		console.log(error.name);
	}
}
let empty = 0;
console.log(
	[].includes(1, {
		valueOf() {
			empty++;
			throw new Error("empty");
		},
	}),
	empty,
);
console.log(
	{}.hasOwnProperty({
		toString() {
			empty++;
			return "x";
		},
	}),
	empty,
);
let effects = 0;
function produce() {
	effects++;
	return 1;
}
console.log({ a: produce() }.hasOwnProperty("a"), effects);
console.log(
	Object.hasOwn(
		{ a: 1 },
		{
			toString() {
				effects++;
				return "a";
			},
		},
	),
	effects,
);

function observingKey() {
	const object = { a: 1 };
	const read = () => object;
	const key = {
		toString() {
			delete read().a;
			return "a";
		},
	};
	return object.hasOwnProperty(key);
}
function observingFrom() {
	const values = ["foo", "bar"];
	const read = () => values;
	return values.includes("new", {
		valueOf() {
			read()[0] = "new";
			return 0;
		},
	});
}
console.log(observingKey(), observingFrom());

function indexOf(value, from) {
	return ["foo", "bar", , undefined, NaN, -0, 2.5, 5n, "foo"].indexOf(value, from);
}
function lastIndexOf(value, from) {
	return ["foo", "bar", , undefined, NaN, -0, 2.5, 5n, "foo"].lastIndexOf(value, from);
}
function lastIndexOfMissing(value) {
	return ["foo", "bar", , undefined, NaN, -0, 2.5, 5n, "foo"].lastIndexOf(value);
}
for (const value of ["foo", "missing", undefined, NaN, 0, 5, 5n, {}, Symbol()]) {
	console.log(lastIndexOfMissing(value));
	for (const from of [undefined, -Infinity, Infinity, -20, -9, -4, -0, 2.9, "1", null])
		console.log(indexOf(value, from), lastIndexOf(value, from));
}
for (const search of [indexOf, lastIndexOf]) {
	console.log(
		search("foo", {
			valueOf() {
				conversions++;
				return -1;
			},
		}),
		conversions,
	);
	for (const from of [
		1n,
		Symbol(),
		{
			valueOf() {
				throw new Error("search coercion");
			},
		},
	]) {
		try {
			search("foo", from);
		} catch (error) {
			console.log(error.name);
		}
	}
}
const emptyFrom = {
	valueOf() {
		throw new Error("empty search must skip coercion");
	},
};
console.log(
	[].indexOf(produce(), emptyFrom),
	[].lastIndexOf(produce(), emptyFrom),
	effects,
);
console.log([,].indexOf(undefined), [,].lastIndexOf(undefined));
console.log([, undefined].indexOf(undefined), [, undefined].lastIndexOf(undefined));
function observingIndexFrom(reverse) {
	const values = ["foo", "bar"];
	const read = () => values;
	const from = {
		valueOf() {
			read()[0] = "new";
			return 0;
		},
	};
	return reverse ? values.lastIndexOf("new", from) : values.indexOf("new", from);
}
console.log(observingIndexFrom(false), observingIndexFrom(true));
const helperIncludes = (values, value, from) => values.includes(value, from);
const helperIndexOf = (values, value, from) => values.indexOf(value, from);
const helperLastIndexOf = (values, value, from) => values.lastIndexOf(value, from);
globalThis.helperIncludes = helperIncludes;
globalThis.helperIndexOf = helperIndexOf;
globalThis.helperLastIndexOf = helperLastIndexOf;
for (const from of [emptyFrom, 1n, Symbol()]) {
	console.log(
		helperIncludes([], produce(), from),
		helperIndexOf([], produce(), from),
		helperLastIndexOf([], produce(), from),
		effects,
	);
}
const inheritedValues = [, "own"];
const selfSearch = (values) => values.includes(values);
const methodSearch = (values) => values.includes(values.includes);
globalThis.selfSearch = selfSearch;
globalThis.methodSearch = methodSearch;
console.log(
	selfSearch([
		undefined,
		0,
		1,
		2,
		3,
		4,
		5,
		6,
		7,
		8,
		9,
		10,
		11,
		12,
		13,
		14,
		15,
		16,
		17,
		18,
		19,
		20,
		21,
		22,
		23,
		24,
		25,
		26,
		27,
		28,
		29,
		30,
	]),
	methodSearch([
		undefined,
		0,
		1,
		2,
		3,
		4,
		5,
		6,
		7,
		8,
		9,
		10,
		11,
		12,
		13,
		14,
		15,
		16,
		17,
		18,
		19,
		20,
		21,
		22,
		23,
		24,
		25,
		26,
		27,
		28,
		29,
		30,
	]),
);
Object.setPrototypeOf(inheritedValues, { 0: "inherited" });
console.log(
	Array.prototype.indexOf.call(inheritedValues, "inherited"),
	Array.prototype.lastIndexOf.call(inheritedValues, "inherited"),
);

console.log(
	[
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
		24, 25, 26, 27, 28, 29, 30, 31,
	].includes(31),
	[
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
		24, 25, 26, 27, 28, 29, 30, 31,
	].includes(32),
	[, , , , , , , , , , , , , , , , ,].includes(undefined, "16"),
	[NaN].includes(NaN),
	[NaN].indexOf(NaN),
	[0].includes(-0),
	[5n].includes(5),
);
let staticIncludesEffects = "";
console.log(
	[NaN, , 1].includes(
		((staticIncludesEffects += "needle;"), NaN),
		((staticIncludesEffects += "from;"), " 0x0 "),
		((staticIncludesEffects += "extra;"), true),
	),
	staticIncludesEffects,
);

function shortDynamicSearch(element, needle) {
	return [
		[element, , undefined, element].indexOf(needle),
		[element, , undefined, element].lastIndexOf(needle),
		[element, , undefined, element].indexOf(needle, "1"),
		[element, , undefined, element].lastIndexOf(needle, null),
		[element, , undefined, element].lastIndexOf(needle, undefined),
		[element, , undefined, element].lastIndexOf(needle, -2),
	];
}
const searchObject = {},
	searchSymbol = Symbol("search");
for (const element of [undefined, NaN, -0, 5n, "same", searchObject, searchSymbol]) {
	for (const needle of [element, undefined, NaN, 0, 5, {}, Symbol("search")])
		console.log(shortDynamicSearch(element, needle).join(","));
}
let shortSearchEffects = "";
function effectfulShortSearch(element, needle) {
	return [element, , element].lastIndexOf(
		((shortSearchEffects += "needle;"), needle),
		((shortSearchEffects += "from;"), "2"),
		((shortSearchEffects += "extra;"), 0),
	);
}
console.log(effectfulShortSearch(searchObject, searchObject), shortSearchEffects);

console.log(
	[].join(),
	["a", "b"].join(undefined),
	["a", , null, undefined, "b"].join("|"),
	[true, false, NaN, Infinity, -Infinity, -0, 2.5, 9007199254740993n].join("/"),
	["a", "b"].join(null),
	["a", "b"].join(5n),
);
const joinedSurrogate = ["\ud800", "x"].join("\udc00");
console.log(
	joinedSurrogate.length,
	joinedSurrogate.charCodeAt(0),
	joinedSurrogate.charCodeAt(1),
);
let staticJoinEffects = "";
console.log(
	[((staticJoinEffects += "first;"), "a"), ((staticJoinEffects += "second;"), "b")].join(
		((staticJoinEffects += "separator;"), "|"),
		((staticJoinEffects += "extra;"), 0),
	),
	staticJoinEffects,
);
const joinMutable = ["old", "tail"];
joinMutable[0] = "new";
console.log(joinMutable.join("|"));
const joiningMutation = [
	{
		toString() {
			joiningMutation[1] = "new";
			return "first";
		},
	},
	"old",
];
console.log(joiningMutation.join("|"));
const joiningCycle = ["first"];
joiningCycle[1] = joiningCycle;
console.log(joiningCycle.join("|"));
let emptyJoinCoercions = 0;
console.log(
	[].join({
		toString() {
			emptyJoinCoercions++;
			return "|";
		},
	}),
	emptyJoinCoercions,
);
for (const values of [[], ["a"]]) {
	try {
		values.join(Symbol("separator"));
	} catch (error) {
		console.log(error.name);
	}
}
try {
	[Symbol("element")].join("|");
} catch (error) {
	console.log(error.name);
}
const joiningInherited = [, "own"];
Object.setPrototypeOf(joiningInherited, {
	get 0() {
		staticJoinEffects += "inherited;";
		return "parent";
	},
});
console.log(Array.prototype.join.call(joiningInherited, "|"), staticJoinEffects);
