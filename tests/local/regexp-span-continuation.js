const gc = globalThis.__mal_collect_garbage;
const rows = [];
function collect() {
	if (typeof gc === "function") gc();
}
function observe(value) {
	collect();
	return `observed:${value}`;
}
function inspect(regexp, source, escape, position, effect) {
	const match = regexp.exec(source);
	if (match === null) return ["miss", regexp.lastIndex];
	const part = match[1];
	effect();
	if (part === undefined) return ["absent", Number(part), regexp.lastIndex];
	const size = part.length;
	if (escape) return [size, observe(part), regexp.lastIndex];
	return [size, part === "if", part.charCodeAt(position), Number(part), regexp.lastIndex];
}
for (const source of [
	"x|if|z",
	"x||z",
	"x| 12 |z",
	"x|-0|z",
	"x|😀|z",
	"x|\ud800y|z",
	"missing",
	"prefix".repeat(200) + "|12|tail",
]) {
	const regexp = /\|([^|]*)\|/g;
	for (const position of [undefined, -1, -0.5, 0, 1.8, 99, NaN, Infinity, "1"]) {
		regexp.lastIndex = 0;
		rows.push(inspect(regexp, source, false, position, collect));
	}
	regexp.lastIndex = 0;
	rows.push(inspect(regexp, source, true, 0, collect));
}
rows.push(inspect(/x(?:\|([^|]*)\|)?/g, "x", false, 0, collect));
function codePoint(source, position) {
	const match = /x(?:\|([^|]*)\|)?/.exec(source);
	if (match === null) return "miss";
	const part = match[1];
	collect();
	if (part === undefined) return "absent";
	const point = part.codePointAt(position);
	return [
		point === undefined,
		point,
		part.codePointAt(),
		part.charCodeAt(position),
		part.length,
	];
}
function codePointBoundary(source, position) {
	const part = /(\ud800)\udc00/.exec(source)[1];
	collect();
	return [part.codePointAt(position), part.length];
}
rows.push(["x|😀|z", "x|\ud800|z", "x|\udc00|z", "x||z", "x", "missing"].map(codePoint));
rows.push(["\ud800\udc00", "x\ud800\udc00"].map(codePointBoundary));
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
	rows.push(codePoint("x|😀|z", position));
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
		codePoint("x|😀|z", position);
	} catch (error) {
		rows.push(error.name);
	}
}
function required(source) {
	const part = /x(?:\|([^|]*)\|)?/.exec(source)[1];
	return part.length + part.charCodeAt(0);
}
function missingIndex(regexp, source) {
	const match = regexp.exec(source);
	if (match === null) return "miss";
	const part = match[2];
	if (part === undefined) return "absent";
	return [part.length, Number(part)];
}
rows.push(missingIndex(/(12)/g, "12"));
for (const source of ["x|ab|", "x", "missing"])
	try {
		rows.push(required(source));
	} catch (error) {
		rows.push(error.name);
	}
function scan(regexp, source) {
	let total = 0;
	for (let index = 0; index < 5; index++) {
		const match = regexp.exec(source);
		if (match === null) continue;
		const part = match[1];
		collect();
		total += part.length + Number(part) + part.codePointAt(0);
	}
	return [total, regexp.lastIndex];
}
rows.push(scan(/(\d+)/g, "1 22 333"));
function materializeAcrossExec(regexp, source) {
	const captures = [];
	for (let index = 0; index < 6; index++) {
		const match = regexp.exec(source);
		if (match === null) {
			captures.push(["miss", regexp.lastIndex]);
			continue;
		}
		const part = match[1];
		if (part === undefined) {
			captures.push(["absent", regexp.lastIndex]);
			continue;
		}
		const first = observe(part);
		collect();
		const second = observe(part);
		captures.push([first, second, part.length, Number(part), regexp.lastIndex]);
	}
	return captures;
}
rows.push(materializeAcrossExec(/(\d+)|x/g, "1 x 22 333"));
function mixedCaptureConsumers(regexp, source) {
	const match = regexp.exec(source);
	if (match === null) return "miss";
	const tail = match[2];
	const firstLength = match[1].length;
	collect();
	if (tail === undefined) return [firstLength, "absent"];
	return [firstLength, tail.length, Number(tail), observe(tail)];
}
for (const source of ["😀|12", "a|", "|7", "missing"])
	rows.push(mixedCaptureConsumers(/([^|]*)\|(\d*)?/, source));
function concatenate(regexp, source) {
	const match = regexp.exec(source);
	if (match === null) return "miss";
	const part = match[1];
	return part.length + part;
}
rows.push(concatenate(/\|([^|]*)\|/, "x|12|z"));
function retainAcrossExec(regexp, source) {
	let previous = "";
	const sizes = [];
	for (let index = 0; index < 3; index++) {
		const match = regexp.exec(source);
		if (match === null) break;
		const part = match[1];
		collect();
		sizes.push(previous.length);
		previous = part;
		sizes.push(part.length);
	}
	return sizes;
}
rows.push(retainAcrossExec(/(\d+)/g, "1 22 333"));
function retainUpperAcrossExec(regexp, source) {
	let previous = "";
	const values = [];
	for (let index = 0; index < 3; index++) {
		const match = regexp.exec(source);
		if (match === null) break;
		const upper = match[1].toUpperCase();
		collect();
		values.push(previous);
		previous = upper;
		values.push(upper.toLowerCase().length);
	}
	return values;
}
function retainLowerAcrossExec(regexp, source) {
	let previous = "";
	const values = [];
	for (let index = 0; index < 3; index++) {
		const match = regexp.exec(source);
		if (match === null) break;
		const lower = match[1].toUpperCase().toLowerCase();
		collect();
		values.push(previous);
		previous = lower;
		values.push(lower.length);
	}
	return values;
}
rows.push(
	retainUpperAcrossExec(/(\w+)/g, "a bb ccc"),
	retainLowerAcrossExec(/(\w+)/g, "A BB CCC"),
);
let coercions = 0;
rows.push(
	inspect(
		/\|([^|]*)\|/g,
		{
			toString() {
				coercions++;
				collect();
				return "x|12|z";
			},
		},
		false,
		{
			valueOf() {
				coercions++;
				collect();
				return 1;
			},
		},
		collect,
	),
	coercions,
);
for (const position of [Symbol("position"), 1n])
	try {
		inspect(/\|([^|]*)\|/g, "x|12|z", false, position, collect);
	} catch (error) {
		rows.push(error.name);
	}
const events = [];
const custom = {
	lastIndex: 5,
	get exec() {
		events.push("method");
		collect();
		return function (source) {
			events.push(source, this === custom);
			collect();
			return {
				get 1() {
					events.push("capture");
					collect();
					return "12";
				},
			};
		};
	},
};
rows.push(inspect(custom, "original", false, 1, collect), events);
["x|😀|z", "x|ab|z", "x||z"].forEach((source) => {
	rows.push(stringCharacters(source, 0, retainedCharacterState));
	rows.push(stringCharacters(source, -1, retainedCharacterState));
	rows.push(stringCharacters(source, undefined, retainedCharacterState));
});
if (typeof process !== "undefined" && process.env.MAL_SPAN_MUTABLE === "mutable") {
	let missingReads = 0;
	let missingReceiver;
	Object.defineProperty(Array.prototype, "2", {
		configurable: true,
		get() {
			missingReads++;
			missingReceiver = this[0];
			collect();
			return "34";
		},
	});
	const inheritedCapture = missingIndex(/(12)/g, "12");
	delete Array.prototype[2];
	rows.push(inheritedCapture, missingReads, missingReceiver);
	const savedPoint = Object.getOwnPropertyDescriptor(String.prototype, "codePointAt"),
		pointEvents = [];
	Object.defineProperty(String.prototype, "codePointAt", {
		configurable: true,
		get() {
			pointEvents.push(String(this));
			collect();
			return savedPoint.value;
		},
	});
	rows.push(codePoint("x|😀|z", 0), pointEvents);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	rows.push(
		codePoint("x|😀|z", {
			valueOf() {
				String.prototype.codePointAt = () => 321;
				collect();
				return 0;
			},
		}),
	);
	Object.defineProperty(String.prototype, "codePointAt", savedPoint);
	const savedCharacter = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
	const receiverEvents = [];
	Object.defineProperty(String.prototype, "charCodeAt", {
		configurable: true,
		get() {
			receiverEvents.push(String(this));
			collect();
			return function (position) {
				return savedCharacter.value.call(this, position);
			};
		},
	});
	rows.push(inspect(/\|([^|]*)\|/, "x|😀|z", false, 1, collect), receiverEvents);
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	rows.push(
		inspect(
			/\|([^|]*)\|/,
			"x|ab|z",
			false,
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
	rows.push(inspect(/\|([^|]*)\|/, "x|ab|z", false, 0, collect));
	Object.defineProperty(String.prototype, "charCodeAt", savedCharacter);
	const savedNumber = Number;
	globalThis.Number = (value) => observe(value);
	rows.push(inspect(/\|([^|]*)\|/, "x|12|z", false, 0, collect));
	globalThis.Number = savedNumber;
}
function stringCharacters(source, position, effect) {
	const kept = effect();
	const match = /x(?:\|([^|]*)\|)?/.exec(source);
	if (match === null) return "miss";
	const part = match[1];
	if (part === undefined) return "absent";
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
				collect();
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
						collect();
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
rows.push(
	stringCharacters("missing", -1, retainedCharacterState),
	stringCharacters("x", -1, retainedCharacterState),
);
console.log(JSON.stringify(rows));
