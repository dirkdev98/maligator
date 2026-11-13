const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function codes(text) {
	const out = [];
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		out.push(character === undefined ? "u" : character.charCodeAt(0).toString(16));
	}
	return out.join(",");
}
function dots(text) {
	let count = 0;
	for (let i = 0; i < text.length; i++) if (text[i] === ".") count++;
	return count;
}

const loops = 2000;
let total = 0;
for (let i = 0; i < loops; i++) total += dots("a.b.c");
record("ascii", total);
record("loops", loops);
record("latin1", codes("caféÿ"));
record("bmp", codes("a€b"));
record("surrogatePair", codes("x😀y"));
record("empty", codes(""));
record("slice", codes("-views-".slice(1, 6)));
record("utf16Slice", codes("€views€".slice(1, 6)));
let rope = "segment-".repeat(4);
for (let i = 0; i < 4; i++) rope += String(i);
record("rope", dots(`${rope}.${rope}`));

function pastEnd(text) {
	const out = [];
	for (let i = 0; i <= text.length; i++) out.push(text[i] === undefined ? "u" : text[i]);
	return out.join("");
}
record("pastEnd", pastEnd("ab"));

function halfSteps(text) {
	const out = [];
	for (let i = 0; i < text.length; i += 0.5)
		out.push(text[i] === undefined ? "u" : text[i]);
	return out.join("");
}
record("fractional", halfSteps("ab"));

function first(value) {
	const out = [];
	for (let i = 0; i < value.length; i++) out.push(String(value[i]));
	return out.join("|");
}
record(
	"mixedReceivers",
	[
		first("xy"),
		first(["x", 1]),
		first(new Uint8Array([7, 8])),
		first({ length: 1, 0: "o" }),
	].join(";"),
);

function widenMidLoop(text) {
	const out = [];
	for (let i = 0; i < text.length; i++) {
		// Reading an attribute widens a Latin-1 string's payload to UTF-16 in place.
		if (i === 2) "x".link(text);
		out.push(text[i]);
	}
	return out.join("");
}
const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)).join(
	"",
);
record("widenMidLoop", widenMidLoop(letters));

String.prototype[1] = "shadow";
String.prototype[2] = "inherited";
record("prototypeIndices", `${first("ab")};${pastEnd("ab")}`);
delete String.prototype[1];
delete String.prototype[2];

console.log(results.join("\n"));
