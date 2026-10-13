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
function characterLoop(source, effect) {
	const part = source.split("|")[1];
	let total = 0;
	for (let index = 0; index < part.length; index++) {
		effect(index);
		total += part.charCodeAt(index);
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
if (typeof process !== "undefined" && process.env.MAL_SPAN_MUTABLE === "mutable") {
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
console.log(JSON.stringify(rows));
