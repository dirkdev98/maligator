const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function codes(text) {
	if (typeof text !== "string") throw new TypeError("expected a string");
	const out = [];
	for (const character of text) out.push(character.codePointAt(0).toString(16));
	return out.join(",");
}
function count(text) {
	let total = 0;
	for (const character of text) total += character.length;
	return total;
}

const loops = 2000;
let ascii = 0;
for (let i = 0; i < loops; i++) ascii += count("views");
record("ascii", ascii);
record("loops", loops);
record("latin1", codes("caféÿ"));
record("bmp", codes("a€b"));
record("surrogatePair", codes("x😀y"));
record("loneSurrogates", codes("\ud800a\udc00\ud800"));
record("empty", codes(""));
record("slice", codes("-views-".slice(1, 6)));
let rope = "segment-".repeat(4);
for (let i = 0; i < 4; i++) rope += String(i);
record("rope", count(rope));

function firstDot(text) {
	let index = 0;
	for (const character of text) {
		if (character === ".") return index;
		index++;
	}
	return -1;
}
record("break", `${firstDot("a.b")},${firstDot("abc")}`);

function throwOnX(text) {
	let seen = "";
	try {
		for (const character of text) {
			if (character === "x") throw new Error(seen);
			seen += character;
		}
	} catch (error) {
		return `caught:${error.message}`;
	}
	return seen;
}
record("throw", throwOnX("abxcd"));

function nested(text) {
	const pairs = [];
	for (const outer of text) for (const inner of text) pairs.push(outer + inner);
	return pairs.join(" ");
}
record("nested", nested("ab"));

function* letters(text) {
	for (const character of text) yield character.toUpperCase();
}
record("generator", [...letters("gen")].join(""));

const iteratorPrototype = Object.getPrototypeOf(
	Object.getPrototypeOf(""[Symbol.iterator]()),
);
function closeAfterPatch(text) {
	const calls = [];
	for (const character of text) {
		if (character === "b") {
			iteratorPrototype.return = function () {
				calls.push(Object.prototype.toString.call(this));
				return {};
			};
			break;
		}
	}
	delete iteratorPrototype.return;
	return calls.join("|");
}
record("returnAddedMidLoop", closeAfterPatch("abc"));

const originalIterator = String.prototype[Symbol.iterator];
String.prototype[Symbol.iterator] = function* () {
	yield "patched";
};
record("patchedIterator", codes("abc"));
String.prototype[Symbol.iterator] = originalIterator;
record("restoredIterator", codes("abc"));

console.log(results.join("\n"));
