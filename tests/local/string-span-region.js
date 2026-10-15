const gc = globalThis.__mal_collect_garbage;
const observations = [];
function collect() {
	if (typeof gc === "function") gc();
}
// A callable proxy preserves the callee's span path when locked calls inline through Reflect.apply.
const searchSplitCallback = new Proxy(searchSplit, {});
["x|😀|z", "x|abab|z", "x||z"].forEach((source) => {
	observations.push(searchRange(source, "a", 0, false, collect));
	observations.push(searchNested(source, "a", 0, collect));
	observations.push(
		Reflect.apply(searchSplitCallback, undefined, [source, "a", 0, collect]),
	);
	observations.push(searchCapture(source, "a", 0, collect));
});
function inspect(value, start, end, escape, observer) {
	const part = value.slice(start, end);
	const length = part.length;
	const equal = part === "ab";
	collect();
	if (escape) return [length, equal, observer(part)];
	return [length, equal, Number(part)];
}
function branch(value, start, end, escape) {
	const part = value.slice(start, end);
	if (part.length === 2 && part === "ab") {
		if (escape) return part;
		return "matched";
	}
	return Number(part);
}
function unicode(value, start, end) {
	const part = value.slice(start, end);
	return [part.length, part === "😀", part !== "\ud83d", Number(part)];
}
function consume(value) {
	collect();
	return `observed:${value}`;
}
function characters(value, start, end, position, effect) {
	const part = value.slice(start, end);
	const length = part.length;
	effect();
	return [length, part.charCodeAt(position), part.charCodeAt(), part.length];
}
function codePoints(value, start, end, position, effect) {
	const part = value.slice(start, end);
	effect();
	const point = part.codePointAt(position);
	return [
		point === undefined,
		point,
		part.codePointAt(),
		part.charCodeAt(position),
		part.length,
	];
}
function substringPoints(value, position) {
	const part = value.substring(3, 1);
	collect();
	const point = part.codePointAt(position);
	return [point === undefined, point, part.codePointAt(), part.length];
}
function substring(value, start, end, escape, observer) {
	const part = value.substring(start, end);
	const length = part.length;
	collect();
	if (escape) return [length, part === "ab", observer(part)];
	return [length, part === "😀", part.charCodeAt(0), Number(part)];
}
function substringMissing(value, start) {
	const whole = value.substring();
	const tail = value.substring(start);
	return [whole.length, whole === "xabz", tail.length, Number(tail)];
}
function selfIndexedCharacter(value) {
	const part = value.slice(1, -1);
	return [part.charCodeAt(part), part.length];
}
for (const value of ["x1z", "x00z", "xabz"])
	observations.push(selfIndexedCharacter(value));
for (const value of ["xabz", "x12z", "x-0z", "xInfinityz", "x😀z", "", "x 7 z"]) {
	for (const bounds of [
		[1, -1],
		[undefined, undefined],
		[-99, 99],
		[NaN, Infinity],
		[Infinity, -Infinity],
		[2.8, 1.2],
		[-0, 2],
		[null, true],
		["3", "1"],
	]) {
		observations.push(inspect(value, bounds[0], bounds[1], false, consume));
		observations.push(inspect(value, bounds[0], bounds[1], true, consume));
		observations.push(substring(value, bounds[0], bounds[1], false, consume));
		observations.push(substring(value, bounds[0], bounds[1], true, consume));
		observations.push(
			branch(value, bounds[0], bounds[1], false),
			branch(value, bounds[0], bounds[1], true),
		);
		observations.push(unicode(value, bounds[0], bounds[1]));
		for (const position of [undefined, NaN, -Infinity, Infinity, -1, -0.5, 0, 1.8, 2, 99])
			observations.push(characters(value, bounds[0], bounds[1], position, collect));
	}
}
observations.push(["xabz", "😀", "12"].map(substringMissing));
observations.push(["x😀z", "x\ud800z", "x\udc00z", "x12z"].map(substringPoints));
for (const value of ["x😀z", "x\ud800z", "x\udc00z", "x\ud800az", "x\udc00\ud800z", ""]) {
	for (const bounds of [
		[1, 3],
		[1, 2],
		[2, 3],
		[0, 0],
		[0, value.length],
	]) {
		for (const position of [
			undefined,
			-0,
			-0.5,
			0,
			1,
			1.9,
			2,
			-1,
			NaN,
			-Infinity,
			Infinity,
			"1",
			null,
		])
			observations.push(codePoints(value, bounds[0], bounds[1], position, collect));
	}
}
for (const position of [
	Symbol("position"),
	1n,
	{
		valueOf() {
			collect();
			throw new RangeError("position");
		},
	},
]) {
	try {
		codePoints("x😀z", 1, 3, position, collect);
	} catch (error) {
		observations.push(error.name);
	}
}

let rope = "";
for (let index = 0; index < 100; index++) rope += index % 2 ? "😀" : "ab";
observations.push(inspect(rope, 1, 190, true, consume), unicode(rope, 2, 4));
observations.push(
	characters(rope, 1, 190, 2, collect),
	codePoints(rope, 1, 190, 2, collect),
	codePoints(rope, 2, 3, 0, collect),
);
observations.push(substring(rope, 190, 1, true, consume));
for (const position of [
	"1",
	null,
	{
		valueOf() {
			collect();
			return 1;
		},
	},
])
	observations.push(characters("x😀z", 1, -1, position, collect));
for (const position of [Symbol("index"), 1n]) {
	try {
		characters("x😀z", 1, -1, position, collect);
	} catch (error) {
		observations.push(error.name);
	}
}
let coercions = 0;
const start = {
	valueOf() {
		coercions++;
		collect();
		return 1;
	},
};
const end = {
	valueOf() {
		coercions++;
		collect();
		return -1;
	},
};
observations.push(inspect("xabz", start, end, true, consume), coercions);
const substringEvents = [];
const substringStart = {
	valueOf() {
		substringEvents.push("start");
		collect();
		return 3;
	},
};
const substringEnd = {
	valueOf() {
		substringEvents.push("end");
		collect();
		return 1;
	},
};
observations.push(substring("xabz", substringStart, substringEnd, true, consume));
observations.push(substringEvents);
for (const bound of [Symbol("bound"), 1n]) {
	try {
		substring("xabz", bound, substringEnd, false, consume);
	} catch (error) {
		observations.push(error.name, substringEvents.length);
	}
}
observations.push(
	substring(
		{
			get substring() {
				substringEvents.push("get");
				collect();
				return function (first, last) {
					substringEvents.push(this.marker, first, last);
					return "ab";
				};
			},
			marker: "receiver",
		},
		1,
		3,
		true,
		consume,
	),
);
const receiver = {
	slice(a, b) {
		observations.push(["override", a, b]);
		collect();
		return "ab";
	},
};
observations.push(inspect(receiver, 1, 2, true, consume));
try {
	inspect(
		"xabz",
		{
			valueOf() {
				coercions++;
				throw new RangeError("bounds");
			},
		},
		3,
		false,
		consume,
	);
} catch (error) {
	observations.push([error.name, coercions]);
}
function delayed(value, effect) {
	const part = value.slice(1, -1);
	const length = part.length;
	effect();
	return [length, Number(part)];
}
const savedNumber = Number;
if (typeof process !== "undefined" && process.env.MAL_STRING_SPAN_MUTABLE === "mutable") {
	const savedSubstring = String.prototype.substring;
	observations.push(
		substring(
			"xabz",
			{
				valueOf() {
					substringEvents.push("replace");
					String.prototype.substring = () => "12";
					collect();
					return 3;
				},
			},
			1,
			true,
			consume,
		),
	);
	observations.push(substring("xabz", 1, 3, true, consume));
	String.prototype.substring = String.prototype.slice;
	observations.push(substring("xabz", 3, 1, true, consume));
	String.prototype.substring = savedSubstring;
	observations.push(substringEvents);
	const savedPoint = Object.getOwnPropertyDescriptor(String.prototype, "codePointAt");
	const pointEvents = [];
	Object.defineProperty(String.prototype, "codePointAt", {
		configurable: true,
		get() {
			pointEvents.push(String(this));
			collect();
			return function (position) {
				pointEvents.push("call", String(this));
				return savedPoint.value.call(this, position);
			};
		},
	});
	observations.push(codePoints("x😀z", 1, 2, 0, collect), pointEvents);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	observations.push(
		codePoints(
			"x😀z",
			1,
			3,
			{
				valueOf() {
					pointEvents.push("coerce");
					String.prototype.codePointAt = () => 321;
					collect();
					return 0;
				},
			},
			collect,
		),
	);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	String.prototype.codePointAt = String.prototype.charCodeAt;
	observations.push(codePoints("x😀z", 1, 3, 0, collect));
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	const savedCharacter = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
	const methodEvents = [];
	Object.defineProperty(String.prototype, "charCodeAt", {
		configurable: true,
		get() {
			methodEvents.push(String(this));
			collect();
			return function (position) {
				return savedCharacter.value.call(this, position);
			};
		},
	});
	observations.push(characters("x😀z", 1, -1, 1, collect), methodEvents);
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	observations.push(
		characters(
			"xabz",
			1,
			-1,
			{
				valueOf() {
					String.prototype.charCodeAt = () => 321;
					collect();
					return 1;
				},
			},
			collect,
		),
	);
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	observations.push(
		delayed("x12z", () => {
			globalThis.Number = (part) => {
				collect();
				return `changed:${part}`;
			};
		}),
	);
	globalThis.Number = savedNumber;
	const original = String.prototype.slice;
	String.prototype.slice = function () {
		return "changed";
	};
	observations.push(inspect("xabz", 1, -1, true, consume));
	String.prototype.slice = original;
}
function nestedSlice(source, start, end, escape, effect) {
	const parent = source.slice(1, -1);
	const before = parent.length;
	const child = parent.substring(start, end);
	effect(parent);
	const size = child.length;
	if (escape) return child;
	return (
		before +
		size +
		child.codePointAt(0) +
		child.charCodeAt(1) +
		Number(child) +
		(child === "😀" ? 10 : 0) +
		parent.length
	);
}
function nestedSubstring(source, start, end) {
	const parent = source.substring(9, 1);
	const child = parent.slice(start, end);
	collect();
	if (start) return child;
	return child.length + child.codePointAt(0) + parent.length;
}
function nestedSplit(source, start, end) {
	const parent = source.split("|")[1];
	if (parent === undefined) return "missing";
	const child = parent.substring(start, end);
	collect();
	if (start) return child;
	return child.length + child.codePointAt(0) + parent.length;
}
function nestedCapture(source, regexp, start, end) {
	const match = regexp.exec(source);
	if (match === null) return "null";
	const parent = match[1];
	if (parent === undefined) return "absent";
	const child = parent.slice(start, end);
	collect();
	if (start) return child;
	return child.length + child.codePointAt(0) + parent.length + regexp.lastIndex;
}
function nestedMissing(source) {
	const parent = source.slice();
	const child = parent.substring();
	return parent.length + child.length + Number(child);
}
for (let repeat = 0; repeat < 4; repeat++) {
	for (const source of [
		"x😀z",
		"x\ud800z",
		"x\udc00z",
		"x12z",
		"x-0z",
		"xInfinityz",
		"",
		"x 7 z",
	]) {
		for (const bounds of [
			[0, 2],
			[2, 0],
			[-1, Infinity],
			[-Infinity, 99],
			[NaN, undefined],
			[-0, 1.8],
			[1, 1],
			[Infinity, -Infinity],
			["1", null],
		]) {
			observations.push(nestedSlice(source, bounds[0], bounds[1], false, collect));
			observations.push(nestedSlice(source, bounds[0], bounds[1], true, collect));
			observations.push(nestedSubstring(source, bounds[0], bounds[1]));
			observations.push(nestedSplit("a|" + source + "|b", bounds[0], bounds[1]));
			observations.push(nestedCapture(source, /(.*)/g, bounds[0], bounds[1]));
		}
		observations.push(nestedMissing(source));
	}
}
observations.push(
	nestedSplit("absent", 0, 2),
	nestedCapture("", /(a)?/, 0, 2),
	nestedCapture("", /(a)/, 0, 2),
);
observations.push(
	nestedSlice("x😀z", 0, 2, false, (parent) => {
		observations.push("parent:" + parent);
		collect();
	}),
);
const nestedEffects = [];
const nestedStart = {
	valueOf() {
		nestedEffects.push("start");
		collect();
		return 2;
	},
};
const nestedEnd = {
	valueOf() {
		nestedEffects.push("end");
		collect();
		return 0;
	},
};
observations.push(
	nestedSlice("x😀z", nestedStart, nestedEnd, true, collect),
	nestedEffects,
);
for (const bound of [
	Symbol("bound"),
	1n,
	{
		valueOf() {
			collect();
			throw new RangeError("bounds");
		},
	},
]) {
	try {
		nestedSlice("x😀z", bound, 2, false, collect);
	} catch (error) {
		observations.push(error.name);
	}
}
if (process.env.MAL_STRING_SPAN_MUTABLE !== "locked") {
	const saved = Object.getOwnPropertyDescriptor(String.prototype, "substring");
	const receiverEvents = [];
	Object.defineProperty(String.prototype, "substring", {
		configurable: true,
		get() {
			receiverEvents.push(String(this));
			collect();
			return saved.value;
		},
	});
	observations.push(nestedSlice("x😀z", 0, 2, true, collect), receiverEvents);
	Object.defineProperty(String.prototype, "substring", saved);
	const changing = {
		valueOf() {
			String.prototype.substring = () => "changed";
			collect();
			return 0;
		},
	};
	observations.push(nestedSlice("x😀z", changing, 2, true, collect));
	Object.defineProperty(String.prototype, "substring", saved);
}
function stringCharacters(source, position, effect) {
	const kept = effect();
	const part = source.slice(1, -1);
	const first = part.charAt(position);
	const last = part.at(position);
	effect();
	return [kept, first, last, last === undefined, part.length, first.length];
}
function retainedCharacterState() {
	collect();
	return { marker: ["kept", "😀", "\ud800"] };
}
for (let repeat = 0; repeat < 4; repeat++)
	for (const word of [
		"😀",
		"\ud800",
		"\udc00",
		"a\ud800b",
		"",
		"abc",
		"x".repeat(300) + "𝄞",
	]) {
		const source = "x" + word + "z";
		for (const position of [
			undefined,
			NaN,
			-Infinity,
			Infinity,
			-99,
			-2,
			-1,
			-0.5,
			-0,
			0,
			0.9,
			1,
			1.8,
			2,
			99,
			"-1",
			null,
			true,
		])
			observations.push(stringCharacters(source, position, retainedCharacterState));
	}
const characterEffects = [];
observations.push(
	stringCharacters(
		"x😀z",
		{
			valueOf() {
				characterEffects.push("position");
				collect();
				return -1;
			},
		},
		retainedCharacterState,
	),
	characterEffects,
);
for (const position of [
	Symbol("position"),
	1n,
	{
		valueOf() {
			collect();
			throw new RangeError("position");
		},
	},
]) {
	try {
		stringCharacters("x😀z", position, retainedCharacterState);
	} catch (error) {
		observations.push(error.name);
	}
}
if (process.env.MAL_STRING_SPAN_MUTABLE !== "locked") {
	for (const method of ["charAt", "at"]) {
		const saved = Object.getOwnPropertyDescriptor(String.prototype, method);
		const receivers = [];
		Object.defineProperty(String.prototype, method, {
			configurable: true,
			get() {
				receivers.push(String(this));
				collect();
				return saved.value;
			},
		});
		observations.push(stringCharacters("x😀z", -1, retainedCharacterState), receivers);
		Object.defineProperty(String.prototype, method, saved);
		observations.push(
			stringCharacters(
				"x😀z",
				{
					valueOf() {
						String.prototype[method] = () => "override";
						collect();
						return 0;
					},
				},
				retainedCharacterState,
			),
		);
		observations.push(stringCharacters("x😀z", 0, retainedCharacterState));
		Object.defineProperty(String.prototype, method, saved);
	}
}
function nestedStringCharacters(source, position, effect) {
	const kept = effect();
	const parent = source.substring(1, 4);
	const part = parent.slice(0, 2);
	const first = part.charAt(position);
	const last = part.at(position);
	effect();
	return [kept, first, last, last === undefined, part.length, parent.length];
}
for (const source of ["x😀z", "x\ud800az", "x\udc00z", "xaz", ""])
	for (const position of [-2, -1, -0.5, 0, 1, 2, undefined])
		observations.push(nestedStringCharacters(source, position, retainedCharacterState));

function deepRange(source, start, end, escape, effect) {
	const outer = source.slice(1, -1);
	const middle = outer.substring(start, end);
	const third = middle.slice(0, 4);
	const leaf = third.substring(0, 2);
	effect(middle);
	if (escape) return leaf;
	return [
		leaf.length,
		leaf.charAt(0),
		leaf.at(-1),
		leaf.codePointAt(0),
		leaf.charCodeAt(1),
		Number(leaf),
		middle.length,
		outer.length,
	];
}
function deepSplit(source, start, end, escape) {
	const outer = source.split("|")[1];
	if (outer === undefined) return "absent";
	const middle = outer.substring(start, end);
	const third = middle.slice(0, 4);
	const leaf = third.substring(0, 2);
	collect();
	if (escape) return leaf;
	return leaf.charAt(0) + leaf.at(-1) + outer.length;
}
function deepCapture(source, regexp, start, end, escape) {
	const match = regexp.exec(source);
	if (match === null) return "null";
	const outer = match[1];
	if (outer === undefined) return "absent";
	const middle = outer.substring(start, end);
	const third = middle.slice(0, 4);
	const leaf = third.substring(0, 2);
	collect();
	if (escape) return leaf;
	return leaf.codePointAt(0) + leaf.length + outer.length + regexp.lastIndex;
}
function deepBranches(source, choice, effect) {
	const outer = source.slice(1, -1);
	const middle = outer.substring(0, 8);
	effect(middle);
	if (choice) {
		const child = middle.slice(0, 4);
		const leaf = child.substring(0, 2);
		return leaf.charAt(0) + leaf.length + middle.length;
	}
	const child = middle.substring(1, 7);
	const leaf = child.slice(0, 2);
	return leaf.at(-1) + leaf.charCodeAt(0) + outer.length;
}
for (let repeat = 0; repeat < 4; repeat++)
	for (const source of [
		"x😀z",
		"x\ud800az",
		"x\udc00z",
		"x12z",
		"",
		"xab".repeat(300) + "z",
	])
		for (const bounds of [
			[0, 2],
			[3, 0],
			[-Infinity, Infinity],
			[NaN, undefined],
			[-0, 1.8],
			["1", null],
		])
			for (const escape of [false, true]) {
				observations.push(deepRange(source, bounds[0], bounds[1], escape, collect));
				observations.push(deepSplit("a|" + source + "|b", bounds[0], bounds[1], escape));
				observations.push(deepCapture(source, /(.*)/g, bounds[0], bounds[1], escape));
				observations.push(deepBranches(source, escape, collect));
			}
observations.push(
	deepSplit("absent", 0, 2, true),
	deepCapture("", /(a)?/, 0, 2, true),
	deepCapture("", /(a)/, 0, 2, true),
);
const deepEvents = [];
const deepStart = {
	valueOf() {
		deepEvents.push("start");
		collect();
		return 0;
	},
};
const deepEnd = {
	valueOf() {
		deepEvents.push("end");
		collect();
		return 2;
	},
};
observations.push(deepRange("x😀z", deepStart, deepEnd, true, collect), deepEvents);
for (const bound of [
	Symbol("start"),
	1n,
	{
		valueOf() {
			collect();
			throw new RangeError("deep bound");
		},
	},
]) {
	try {
		observations.push(deepRange("x😀z", bound, 2, true, collect));
	} catch (error) {
		observations.push(error.name);
	}
}
if (process.env.MAL_STRING_SPAN_MUTABLE !== "locked") {
	const saved = Object.getOwnPropertyDescriptor(String.prototype, "substring");
	const receivers = [];
	Object.defineProperty(String.prototype, "substring", {
		configurable: true,
		get() {
			receivers.push(String(this));
			collect();
			return saved.value;
		},
	});
	observations.push(deepRange("x😀z", 0, 2, true, collect), receivers);
	Object.defineProperty(String.prototype, "substring", saved);
	observations.push(
		deepRange(
			"x😀z",
			{
				valueOf() {
					String.prototype.substring = () => "changed";
					collect();
					return 0;
				},
			},
			2,
			true,
			collect,
		),
	);
	Object.defineProperty(String.prototype, "substring", saved);
}
function retainedDeepCapture(source, regexp) {
	let previous = "";
	const values = [];
	for (let index = 0; index < 3; index++) {
		const outer = regexp.exec(source)[1];
		const middle = outer.substring(0, 8);
		const third = middle.slice(0, 4);
		const leaf = third.substring(0, 2);
		collect();
		values.push(previous.charAt(0), leaf.at(-1));
		previous = third;
	}
	return values;
}
observations.push(retainedDeepCapture("ab cd ef", /(\w+)/g));

function searchRange(source, needle, position, escape, effect) {
	const part = source.slice(1, -1);
	const first = part.indexOf(needle, position);
	const contained = part.includes(needle, position);
	const starts = part.startsWith(needle, position);
	const ends = part.endsWith(needle, position);
	effect();
	if (escape) return part;
	return [first, contained, starts, ends, part.length];
}
function searchNested(source, needle, position, effect) {
	const outer = source.substring(1, 1000);
	const middle = outer.slice(0, -1);
	const inner = middle.substring(0, 1000);
	const part = inner.slice(0, 600);
	const first = part.indexOf(needle, position);
	effect();
	return [
		first,
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
		outer.length,
	];
}
function searchSplit(source, needle, position, effect) {
	const part = source.split("|")[1];
	if (part === undefined) return "absent";
	const first = part.indexOf(needle, position);
	effect();
	return [
		first,
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
}
function searchCapture(source, needle, position, effect) {
	const match = /x(?:\|([^|]*)\|)?/.exec(source);
	if (match === null) return "null";
	const part = match[1];
	if (part === undefined) return "absent";
	const first = part.indexOf(needle, position);
	effect();
	return [
		first,
		part.includes(needle, position),
		part.startsWith(needle, position),
		part.endsWith(needle, position),
	];
}
for (const word of [
	"😀",
	"a\ud800b",
	"\udc00",
	"",
	"undefined",
	"abababab",
	"a".repeat(300) + "b",
])
	for (const needle of ["", "😀", "\ud800", "\ude00", "a", "b", "z", "a".repeat(33)])
		for (const position of [
			undefined,
			NaN,
			-Infinity,
			Infinity,
			-2,
			-0,
			0.9,
			1.8,
			2,
			600,
		]) {
			observations.push(searchRange("x" + word + "z", needle, position, false, collect));
			observations.push(searchNested("x" + word + "z", needle, position, collect));
			observations.push(searchSplit("x|" + word + "|z", needle, position, collect));
			observations.push(searchCapture("x|" + word + "|z", needle, position, collect));
		}

observations.push(
	searchSplit("missing", "a", 0, collect),
	searchCapture("missing", "a", 0, collect),
	searchCapture("x", "a", 0, collect),
);
const searchEvents = [];
const searchNeedle = {
	get [Symbol.match]() {
		searchEvents.push("match");
		collect();
		return false;
	},
	toString() {
		searchEvents.push("needle");
		collect();
		return "a";
	},
};
const searchPosition = {
	valueOf() {
		searchEvents.push("position");
		collect();
		return 0;
	},
};
observations.push(
	searchRange("xabz", searchNeedle, searchPosition, false, collect),
	searchEvents,
);
for (const needle of [
	undefined,
	null,
	true,
	1n,
	Symbol("needle"),
	/a/,
	{
		get [Symbol.match]() {
			collect();
			throw new RangeError("match");
		},
	},
]) {
	try {
		observations.push(searchRange("xundefinedz", needle, 0, false, collect));
	} catch (error) {
		observations.push(error.name);
	}
}
for (const position of [
	"1",
	null,
	true,
	1n,
	Symbol("position"),
	{
		valueOf() {
			collect();
			throw new RangeError("position");
		},
	},
]) {
	try {
		observations.push(searchRange("xabz", "", position, false, collect));
	} catch (error) {
		observations.push(error.name);
	}
}
function missingSearch(source) {
	const part = source.slice(1, -1);
	return [part.indexOf(), part.includes(), part.startsWith(), part.endsWith()];
}
observations.push(missingSearch("xundefinedz"), missingSearch("xabz"));
if (process.env.MAL_STRING_SPAN_MUTABLE !== "locked") {
	for (const method of ["indexOf", "includes", "startsWith", "endsWith"]) {
		const saved = Object.getOwnPropertyDescriptor(String.prototype, method);
		const events = [];
		Object.defineProperty(String.prototype, method, {
			configurable: true,
			get() {
				events.push(String(this));
				collect();
				return saved.value;
			},
		});
		observations.push(searchRange("xabz", "a", 0, false, collect), events);
		Object.defineProperty(String.prototype, method, saved);
		observations.push(
			searchRange(
				"xabz",
				{
					toString() {
						String.prototype[method] = () => "override";
						collect();
						return "a";
					},
				},
				0,
				false,
				collect,
			),
		);
		Object.defineProperty(String.prototype, method, saved);
	}
}
if (process.env.MAL_STRING_SPAN_MUTABLE !== "locked") {
	const savedExec = RegExp.prototype.exec;
	const execEvents = [];
	RegExp.prototype.exec = function (source) {
		execEvents.push(source);
		return savedExec.call(this, source);
	};
	const needle = {
		get [Symbol.match]() {
			execEvents.push("match");
			collect();
			return false;
		},
		toString() {
			execEvents.push("needle");
			return "a";
		},
	};
	observations.push(
		searchCapture(
			"x|ab|z",
			needle,
			{
				valueOf() {
					execEvents.push("position");
					collect();
					return 0;
				},
			},
			collect,
		),
		execEvents,
	);
	RegExp.prototype.exec = savedExec;
}
console.log(JSON.stringify(observations));
