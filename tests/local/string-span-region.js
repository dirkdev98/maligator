const gc = globalThis.__mal_collect_garbage;
const observations = [];
function collect() {
	if (typeof gc === "function") gc();
}
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
	]) {
		observations.push(inspect(value, bounds[0], bounds[1], false, consume));
		observations.push(inspect(value, bounds[0], bounds[1], true, consume));
		observations.push(
			branch(value, bounds[0], bounds[1], false),
			branch(value, bounds[0], bounds[1], true),
		);
		observations.push(unicode(value, bounds[0], bounds[1]));
		for (const position of [undefined, NaN, -Infinity, Infinity, -1, -0.5, 0, 1.8, 2, 99])
			observations.push(characters(value, bounds[0], bounds[1], position, collect));
	}
}
let rope = "";
for (let index = 0; index < 100; index++) rope += index % 2 ? "😀" : "ab";
observations.push(inspect(rope, 1, 190, true, consume), unicode(rope, 2, 4));
observations.push(characters(rope, 1, 190, 2, collect));
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
console.log(JSON.stringify(observations));
