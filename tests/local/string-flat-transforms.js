// Case mapping, literal replacement, splitting, trimming and searching over Latin-1,
// two-byte, sliced and concatenated strings. The output lists UTF-16 code units so lone
// surrogates and representation changes compare exactly with Node.

function units(value) {
	if (Array.isArray(value)) return `[${value.map(units).join(",")}]`;
	if (typeof value !== "string") return String(value);
	let out = "";
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		out +=
			unit >= 0x20 && unit < 0x7f && unit !== 0x5c
				? value[index]
				: `\\u${unit.toString(16).padStart(4, "0")}`;
	}
	return `"${out}"`;
}

const results = [];
function show(name, value) {
	results.push(`${name}: ${units(value)}`);
}

// Values read through an array keep the receiver type unknown to the compiler, so the
// calls dispatch to the builtins; literal receivers may take compiled direct paths.
const opaque = (value) => [value][0];
const long = (piece, count) => Array.from({ length: count }, () => piece).join("");
// A slice of a wider parent and a concatenation exercise dependent and rope receivers.
const sliced = (value) => opaque(`#${value}#`).slice(1, -1);
const rope = (value) => {
	const middle = value.length >> 1;
	return opaque(value.slice(0, middle)) + opaque(value.slice(middle));
};
const shapes = (value) => [
	["flat", opaque(value)],
	["sliced", sliced(value)],
	["rope", rope(value)],
];

const caseInputs = [
	"item=3;price=51;quantity=4; café-Σ-😀",
	"straße ŉ ǰ ﬀ ᾳ",
	"İstanbul İ i̇",
	"ΣΑΣ ΑΣ. Σ ΑΣ'Σ ΑΣ́ ΑΣΑ Σ́ aΣ 1Σ",
	"ა ბ გ Ა Ბ Ⴀ ⴀ",
	"𐐀𐐁 𐐨𐐩 𐐀x",
	"lone \ud800 lead \udc00 trail end \ud83d",
	"\ud83d",
	"\udc00\ud83d",
	"KÅ ı ſ µ ÿ Ÿ ß",
	"ascii only CASE run",
	"ABCDEFGHé ABCDEFGHIJKLMNOP abcdefghΣabcdefghijklmnop",
	"中文不变",
	long("aé中Ω", 40),
	long("KΣ", 140),
	long("Ωω", 70),
];
for (const [index, input] of caseInputs.entries()) {
	for (const [shape, value] of shapes(input)) {
		show(`upper ${index} ${shape}`, value.toUpperCase());
		show(`lower ${index} ${shape}`, value.toLowerCase());
	}
	show(`literal upper ${index}`, input.toUpperCase());
	show(`literal lower ${index}`, input.toLowerCase());
}
show("narrowed upper", opaque("ıſ").toUpperCase());
show("narrowed lower", opaque("KÅÀ").toLowerCase());

const replaceCases = [
	["a=b=c", "=", ":"],
	["aaaa", "aa", "b"],
	["aaaaa", "aa", ""],
	["abc", "", "-"],
	["", "", "-"],
	["", "x", "-"],
	["abc", "x", "-"],
	["latin1 only", "Σ", "s"],
	["aΣbΣc", "Σ", "s"],
	["aΣbΣc", "b", "β"],
	["a😀b😀", "😀", "!"],
	["a😀b😀", "\ud83d", "?"],
	["a😀b", "\ude00", "?"],
	["xéx", "é", "e"],
	["same same", "same", "same"],
	["dollar", "l", "$&$&"],
	["dollar", "l", "$$"],
	["dollar", "l", "[$`|$']"],
	["dollar", "l", "$1$<x>"],
	["café-Σ-😀", "-", ""],
	["ab", "ab", ""],
	[long("k=v;", 100), "=", ":"],
	[long("Σ=v;", 100), ";", ""],
	[long("aΣ", 150), "Σ", "b"],
];
for (const [index, [subject, search, replacement]] of replaceCases.entries()) {
	for (const [shape, value] of shapes(subject)) {
		show(
			`replaceAll ${index} ${shape}`,
			value.replaceAll(opaque(search), opaque(replacement)),
		);
		show(`replace ${index} ${shape}`, value.replace(opaque(search), opaque(replacement)));
	}
	show(`literal replaceAll ${index}`, subject.replaceAll(search, replacement));
	show(`literal replace ${index}`, subject.replace(search, replacement));
}

const splitCases = [
	["item=3;price=51;quantity=4; café-Σ-😀", ";"],
	["a,b,,c,", ","],
	[",a,,", ","],
	["", ","],
	["", ""],
	["abc", ""],
	["a😀b", ""],
	["no separator", ","],
	["a--b----", "--"],
	["aaaaa", "aa"],
	["αΣβΣγ", "Σ"],
	["latin1 only", "Σ"],
	["a😀b😀c", "😀"],
	["a😀b😀c", "\ud83d"],
	["\ud83dx\ud83d", "\ud83d"],
	["xéyéz", "é"],
	[
		"short;a much longer piece than sixteen units;é;Σ wide piece longer than sixteen",
		";",
	],
	[long("x,", 100) + "tail", ","],
	[long("Σ,", 100) + "tail", ","],
	[long("x--", 70) + "tail", "--"],
	["separator longer", "separator longer than subject"],
];
for (const [index, [subject, separator]] of splitCases.entries()) {
	for (const [shape, value] of shapes(subject)) {
		show(`split ${index} ${shape}`, value.split(opaque(separator)));
		for (const limit of [0, 1, 2, 3, 65, -1, 4294967297, undefined, 2.5, "2", null, true])
			show(
				`split ${index} ${shape} ${limit}`,
				value.split(opaque(separator), opaque(limit)),
			);
	}
	show(`literal split ${index}`, subject.split(separator));
}

const trimInputs = [
	"  item=3; café-Σ-😀  ",
	"\t\n\v\f\r x \r\n",
	"        　﻿x﻿　",
	"᠎x᠎",
	"\u0085x\u0085",
	"​x​",
	"   ",
	"",
	"no edges",
];
for (const [index, input] of trimInputs.entries()) {
	for (const [shape, value] of shapes(input)) {
		show(`trim ${index} ${shape}`, [value.trim(), value.trimStart(), value.trimEnd()]);
	}
	show(`number ${index}`, Number(`${input}7${input}`));
}

const searchSubjects = [
	"item=3;price=51;quantity=4; café-Σ-😀",
	"0123456789abcdefΣ0123456789abcdef",
	long("abcdefgh", 12) + "Σ" + long("ijkl", 3),
];
const needles = ["price", "café", "Σ", "😀", "\ude00", "h", "fΣ0", "ijkl", "missing", ""];
for (const [index, subject] of searchSubjects.entries()) {
	for (const [shape, value] of shapes(subject)) {
		for (const needle of needles) {
			show(`indexOf ${index} ${shape} ${units(needle)}`, value.indexOf(opaque(needle)));
			show(
				`includes ${index} ${shape} ${units(needle)}`,
				value.includes(opaque(needle), 3),
			);
		}
	}
}

console.log(results.join("\n"));
