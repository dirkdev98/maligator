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
		total += part.length + Number(part);
	}
	return [total, regexp.lastIndex];
}
rows.push(scan(/(\d+)/g, "1 22 333"));
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
console.log(JSON.stringify(rows));
