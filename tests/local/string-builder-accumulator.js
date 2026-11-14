const results = [];
function record(label, value) {
	results.push(`${label}=${typeof value === "string" ? JSON.stringify(value) : value}`);
}

const segments = [];
function keep(segment) {
	segments.push(segment);
	return segment.length;
}

// The dot-prop shape: characters accumulate until a separator hands the segment to a call.
function parsePath(path) {
	if (typeof path !== "string") throw new TypeError("expected a string");
	const parts = [];
	let segment = "";
	let escaping = false;
	for (const character of path) {
		if (escaping) {
			segment += character;
			escaping = false;
			continue;
		}
		if (character === "\\") {
			escaping = true;
			continue;
		}
		if (character === ".") {
			if (segment !== "") keep(segment);
			parts.push(segment);
			segment = "";
			continue;
		}
		if (character === "[") {
			if (segment.length <= 9 && segment === "__proto__") return [];
			segment += "[]";
			continue;
		}
		segment += character;
	}
	if (escaping) segment += "\\";
	parts.push(segment);
	return parts;
}

const appendLoops = 3000;
let parsedLength = 0;
for (let i = 0; i < appendLoops; i++) parsedLength += parsePath("views.title.id").length;
record("appendLoops", appendLoops);
record("parsedLength", parsedLength);
record("parse", parsePath("a.b\\.c.d[x").join("|"));
record("proto", parsePath("__proto__[").length);
record("kept", segments.slice(0, 4).join(","));
record("empty", parsePath("").join("|"));
record("latin1", parsePath("café.ÿø").join("|"));
record("bmp", parsePath("a€b.€").join("|"));
record("pairs", parsePath("x😀y.😀").join("|"));
record(
	"lone",
	parsePath("\ud800a.\udc00")
		.map((part) => part.length)
		.join(","),
);

function observers(text) {
	let value = "";
	const seen = [];
	const object = {};
	const map = new Map();
	for (const character of text) {
		value += character;
		seen.push(value);
		object[value] = value.length;
		map.set(value, seen.length);
		if (value === "ab") seen.push("eq");
		if (value !== "abc") seen.push("ne");
		if (value == "a") seen.push("loose");
		seen.push(typeof value, value[0], value.charCodeAt(value.length - 1));
		seen.push(`${value}!`, JSON.stringify(value));
		switch (value) {
			case "a":
				seen.push("switch-a");
				break;
			case "abcd":
				seen.push("switch-abcd");
				break;
			default:
				seen.push("switch-other");
		}
	}
	return [seen.join(" "), Object.keys(object).join(","), map.get("abc"), object.ab];
}
record("observers", observers("abcd").join("/"));

function returned(text) {
	let value = "";
	for (const character of text) value += character;
	return value;
}
record("returned", returned("returned"));
record("returnedEmpty", returned(""));
record("returnedWide", returned("wide€😀"));

function captured(text) {
	const snapshots = [];
	let value = "";
	for (const character of text) {
		value += character;
		const snapshot = value;
		snapshots.push(() => snapshot);
	}
	return snapshots.map((read) => read()).join(",");
}
record("captured", captured("cap"));

function capturedAccumulator(text) {
	let value = "";
	const read = () => value;
	const reads = [];
	for (const character of text) {
		value += character;
		reads.push(read());
	}
	return reads.join(",");
}
record("capturedAccumulator", capturedAccumulator("acc"));

function thrown(text) {
	let value = "";
	try {
		for (const character of text) {
			if (character === "!") throw value;
			value += character;
		}
	} catch (error) {
		return `caught:${error}`;
	}
	return value;
}
record("thrown", thrown("throw!n"));

function caughtAppend(values) {
	let value = "";
	const outcomes = [];
	for (const item of values) {
		try {
			value += item;
		} catch (error) {
			outcomes.push(`${error.constructor.name}@${value}`);
		}
	}
	outcomes.push(value);
	return outcomes.join(";");
}
record(
	"mixed",
	caughtAppend([
		"a",
		1,
		null,
		undefined,
		true,
		2.5,
		-0,
		{ toString: () => "obj" },
		[1, 2],
		Symbol("no"),
		"z",
		{
			valueOf() {
				throw new RangeError("valueOf");
			},
		},
		"end",
	]),
);

function numeric(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}
record("numeric", numeric([1, 2, 3.5]));
record("numericThenString", numeric([1, 2, "3", 4]));

function chunks(count) {
	let value = "";
	for (let i = 0; i < count; i++) value += i % 2 === 0 ? "ab" : "c";
	return value;
}
record("chunks", chunks(7));

function prefixed(prefix, text) {
	let value = prefix;
	for (const character of text) value += character;
	return value;
}
record("prefixed", prefixed("pre-", "fix"));
record("prefixedLong", prefixed("p".repeat(200), "xy").length);

function resets(text) {
	const words = [];
	let word = "start:";
	for (const character of text) {
		if (character === " ") {
			words.push(word);
			word = words.length % 2 === 0 ? "" : "odd:";
			continue;
		}
		word += character;
	}
	words.push(word);
	return words.join("|");
}
record("resets", resets("one two three four"));

function doubled(rounds) {
	let value = "ab";
	for (let i = 0; i < rounds; i++) value += value;
	return value;
}
record("doubled", doubled(4));
record("doubledLong", doubled(12).length);

function interleaved(text) {
	let even = "";
	let odd = "";
	let index = 0;
	for (const character of text) {
		if (index++ % 2 === 0) even += character;
		else odd += character;
	}
	return `${even}:${odd}`;
}
record("interleaved", interleaved("abcdefg"));

function long(count) {
	let value = "";
	for (let i = 0; i < count; i++) value += String.fromCharCode(97 + (i % 26));
	let checksum = 0;
	for (let i = 0; i < value.length; i += 97)
		checksum = (checksum * 31 + value.charCodeAt(i)) | 0;
	return `${value.length}:${checksum}:${value.slice(-5)}`;
}
record("long", long(10000));
record("boundary", [127, 128, 129, 300].map((count) => long(count)).join(","));

function wideLong(count) {
	let value = "";
	for (let i = 0; i < count; i++) value += i % 50 === 0 ? "€" : "a";
	return `${value.length}:${value.indexOf("€", 1)}:${value.lastIndexOf("€")}`;
}
record("wideLong", wideLong(400));

function grows(limit) {
	let value = "";
	while (value.length < limit) value += "x";
	return value;
}
record("grows", grows(5));

function aliases(text) {
	let value = "";
	const seen = [];
	for (const character of text) {
		const before = value;
		value += character;
		const extended = value + "?";
		seen.push(before, extended);
		value += "";
	}
	return `${seen.join(",")}|${value}`;
}
record("aliases", aliases("abc"));

function handlerReads(items) {
	let value = "";
	for (const item of items) {
		try {
			value += item;
			if (item === "boom") throw new Error(value);
		} catch (error) {
			value += `!${error.message.length}`;
		}
	}
	return value;
}
record("handlerReads", handlerReads(["a", "boom", "b"]));

function compared(text, other) {
	let value = "";
	let matches = 0;
	for (const character of text) {
		value += character;
		if (value === other) matches++;
		if (value === 5) matches += 100;
	}
	return matches;
}
record("compared", compared("abcabc", "abc"));

function recursive(depth) {
	let value = "";
	for (let i = 0; i < 3; i++) value += String(depth);
	return depth === 0 ? value : `${value}(${recursive(depth - 1)})`;
}
record("recursive", recursive(3));

function garbage(rounds) {
	let total = 0;
	const kept = [];
	for (let round = 0; round < rounds; round++) {
		let value = "";
		for (const character of "garbage-collected") {
			value += character;
			// Allocation between appends lets a stressed collector run while the buffer is live.
			kept.push({ round, character });
		}
		total += value.length;
		if (round % 50 === 0) kept.length = 0;
	}
	return total;
}
record("garbage", garbage(400));

console.log(results.join("\n"));
