const gc = globalThis.__mal_collect_garbage;
const rows = [];
function observe(value) {
	if (typeof gc === "function") gc();
	return "observed:" + value;
}
function classify(source, escape) {
	const part = source.split("|")[1];
	const size = part.length;
	if (part === "if") return size + 10;
	if (escape) return observe(part);
	return size;
}
function compare(source, other) {
	const part = source.split("|")[1];
	return [part.length, part === other, part !== other];
}
function character(source, index) {
	const part = source.split("|")[1];
	return [part.length, part.charCodeAt(index), Number(part)];
}
function codePoint(source, index) {
	const part = source.split("|")[1];
	observe("point");
	const point = part.codePointAt(index);
	return [
		point === undefined,
		point,
		part.codePointAt(),
		part.charCodeAt(index),
		part.length,
	];
}
function codePointBoundary(source, index) {
	const part = source.split("\udc00")[0];
	return [part.codePointAt(index), part.length];
}
function characterLoop(source, effect) {
	const part = source.split("|")[1];
	let total = 0;
	for (let index = 0; index < part.length; index++) {
		effect(index);
		total += part.charCodeAt(index) + part.codePointAt(index);
	}
	return total;
}
function selfIndexedCharacter(source) {
	const part = source.split("|")[1];
	return [part.charCodeAt(part), part.length];
}
for (const source of ["x|1|z", "x|00|z", "x|ab|z"])
	rows.push(selfIndexedCharacter(source));
function retain(source) {
	const part = source.split("|")[1];
	if (part.length > 2) return part;
	return part === "if";
}
for (const source of [
	"a|if|tail",
	"a|else|tail",
	"a||",
	"|𝄞|",
	"x|\ud800y|z",
	"x| 12 |z",
	"x|-0|z",
	"z|" + "x".repeat(300) + "|end",
	"prefix".repeat(100) + "|if|".repeat(100),
]) {
	rows.push(classify(source, false), classify(source, true), retain(source));
	for (const index of [undefined, -Infinity, -1, -0.5, 0, 1, 0.9, NaN, Infinity, "0"])
		rows.push(character(source, index));
	for (const other of ["if", 2, null, undefined, Object("if")])
		rows.push(compare(source, other));
}
for (const index of [
	null,
	{
		valueOf() {
			observe("coercion");
			return 1;
		},
	},
])
	rows.push(character("x|😀|z", index));
for (const index of [Symbol("index"), 1n]) {
	try {
		character("x|😀|z", index);
	} catch (error) {
		rows.push(error.name);
	}
}
try {
	rows.push(classify("missing", false));
} catch (error) {
	rows.push(error.name);
}
let checksum = 0;
for (let i = 0; i < 400; i++) checksum += classify(i % 2 ? "a|if|z" : "a|else|z", false);
rows.push(checksum, ["a|if|z", "a|else|z"].map(classify));
rows.push(["x|AB|z", "x|😀|z", "x|12|z"].map(character));
rows.push(["x|😀|z", "x|\ud800|z", "x|\udc00|z", "x||z"].map(codePoint));
rows.push(["\ud800\udc00", "\ud800x\udc00"].map(codePointBoundary));
for (const index of [
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
	rows.push(codePoint("x|😀|z", index));
for (const index of [
	Symbol("position"),
	1n,
	{
		valueOf() {
			observe("coerce");
			throw new RangeError("position");
		},
	},
]) {
	try {
		codePoint("x|😀|z", index);
	} catch (error) {
		rows.push(error.name);
	}
}
try {
	codePoint("missing", 0);
} catch (error) {
	rows.push(error.name);
}

if (typeof process !== "undefined" && process.env.MAL_SPAN_MUTABLE === "mutable") {
	const savedPoint = Object.getOwnPropertyDescriptor(String.prototype, "codePointAt"),
		pointEvents = [];
	Object.defineProperty(String.prototype, "codePointAt", {
		configurable: true,
		get() {
			pointEvents.push(String(this));
			observe("getter");
			return savedPoint.value;
		},
	});
	rows.push(codePoint("x|😀|z", 0), pointEvents);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	rows.push(
		codePoint("x|😀|z", {
			valueOf() {
				String.prototype.codePointAt = () => 321;
				observe("coerce");
				return 0;
			},
		}),
	);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	const savedCharacter = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
	const methodEvents = [];
	Object.defineProperty(String.prototype, "charCodeAt", {
		configurable: true,
		get() {
			methodEvents.push(String(this));
			observe("getter");
			return function (index) {
				return savedCharacter.value.call(this, index);
			};
		},
	});
	rows.push(character("x|😀|z", 1), methodEvents);
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	rows.push(
		character("x|ab|z", {
			valueOf() {
				String.prototype.charCodeAt = () => 321;
				observe("coercion");
				return 1;
			},
		}),
	);
	rows.push(character("x|ab|z", 0));
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	rows.push(
		characterLoop("x|abcdef|z", (index) => {
			if (index === 2) String.prototype.charCodeAt = () => 500;
			observe("loop");
		}),
	);
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	const savedNumber = Number;
	globalThis.Number = (value) => {
		observe("number");
		return `number:${value}`;
	};
	rows.push(character("x|12|z", 0));
	globalThis.Number = savedNumber;
	const original = String.prototype.split;
	let calls = 0;
	String.prototype.split = function () {
		calls++;
		return {
			get 1() {
				calls += 10;
				return "if";
			},
		};
	};
	rows.push(classify("ignored", false), calls);
	String.prototype.split = original;
}
function stringCharacters(source, position, effect) {
	const kept = effect();
	const part = source.split("|")[1];
	if (part === undefined) return "missing";
	const first = part.charAt(position);
	const last = part.at(position);
	effect();
	return [kept, first, last, last === undefined, part.length, first.length];
}
function retainedCharacterState() {
	observe();
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
		const source = "x|" + word + "|z";
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
			rows.push(stringCharacters(source, position, retainedCharacterState));
	}
const characterEffects = [];
rows.push(
	stringCharacters(
		"x|😀|z",
		{
			valueOf() {
				characterEffects.push("position");
				observe();
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
			observe();
			throw new RangeError("position");
		},
	},
]) {
	try {
		stringCharacters("x|😀|z", position, retainedCharacterState);
	} catch (error) {
		rows.push(error.name);
	}
}
if (process.env.MAL_SPAN_MUTABLE !== "locked") {
	for (const method of ["charAt", "at"]) {
		const saved = Object.getOwnPropertyDescriptor(String.prototype, method);
		const receivers = [];
		Object.defineProperty(String.prototype, method, {
			configurable: true,
			get() {
				receivers.push(String(this));
				observe();
				return saved.value;
			},
		});
		rows.push(stringCharacters("x|😀|z", -1, retainedCharacterState), receivers);
		Object.defineProperty(String.prototype, method, saved);
		rows.push(
			stringCharacters(
				"x|😀|z",
				{
					valueOf() {
						String.prototype[method] = () => "override";
						observe();
						return 0;
					},
				},
				retainedCharacterState,
			),
		);
		rows.push(stringCharacters("x|😀|z", 0, retainedCharacterState));
		Object.defineProperty(String.prototype, method, saved);
	}
}
rows.push(stringCharacters("missing", -1, retainedCharacterState));
console.log(JSON.stringify(rows));
