const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const rows = [];
function collect() {
	if (typeof gc === "function") gc();
}
function primitiveSlice(source, start, end, position) {
	const part = source.slice(start, end);
	collect();
	return [
		part.charAt(position),
		part.at(position),
		part.charCodeAt(position),
		part.codePointAt(position),
		part.length,
	];
}
function primitiveSubstring(source, start, end, position) {
	const part = source.substring(start, end);
	collect();
	return [
		part.indexOf("a", position),
		part.lastIndexOf("a", position),
		part.includes("a", position),
		part.startsWith("a", position),
		part.endsWith("a", position),
		part.length,
	];
}
function primitiveSubstr(source, start, count, position) {
	const part = source.substr(start, count);
	collect();
	return [
		part.indexOf("a", position),
		part.lastIndexOf("a", position),
		part.includes("a", position),
		part.startsWith("a", position),
		part.endsWith("a", position),
		part.length,
	];
}
function primitiveNested(source, position) {
	const parent = source.slice("1", "-1");
	const part = parent.substring(false, "8");
	collect();
	return [
		part.indexOf("a", position),
		part.lastIndexOf("a", position),
		part.includes("a", position),
		part.startsWith("a", position),
		part.endsWith("a", position),
		part.length,
		parent.length,
	];
}
function primitiveSplit(source, position) {
	const part = source.split("|")[1];
	if (part === undefined) return "absent";
	collect();
	return [
		part.indexOf("a", position),
		part.lastIndexOf("a", position),
		part.includes("a", position),
		part.startsWith("a", position),
		part.endsWith("a", position),
		part.length,
	];
}
function primitiveCapture(regexp, source, position) {
	const match = regexp.exec(source);
	if (match === null) return "miss";
	const part = match[1];
	if (part === undefined) return "absent";
	collect();
	return [
		part.indexOf("a", position),
		part.lastIndexOf("a", position),
		part.includes("a", position),
		part.startsWith("a", position),
		part.endsWith("a", position),
		part.length,
		regexp.lastIndex,
	];
}
function directPrimitives(source, position) {
	return [
		source.charAt(position),
		source.at(position),
		source.charCodeAt(position),
		source.codePointAt(position),
		source.indexOf("a", position),
		source.lastIndexOf("a", position),
		source.includes("a", position),
		source.startsWith("a", position),
		source.endsWith("a", position),
	];
}
let ropePosition = "";
for (let i = 0; i < 80; i++) ropePosition += "0";
ropePosition += "1";
const positions = [
	null,
	false,
	true,
	"",
	" \ufeff 1 ",
	"-0",
	"1.8",
	"-1.8",
	"NaN",
	"Infinity",
	"-Infinity",
	"0x2",
	"0o2",
	"0b10",
	"invalid",
	"😀",
	ropePosition,
];
const probes = new Array(6);
probes[0] = primitiveSlice;
probes[1] = primitiveSubstring;
probes[2] = primitiveSubstr;
probes[3] = primitiveNested;
probes[4] = primitiveSplit;
probes[5] = primitiveCapture;
for (const position of positions) {
	for (const source of ["[ababa]", "[a😀ba\ud800]", "[]"]) {
		for (let i = 0; i < 3; i++) {
			rows.push(probes[i](source, position, "7", position));
			rows.push(probes[i](source, "0", position, "1"));
		}
		rows.push(probes[3](source, position));
		rows.push(probes[4]("x|" + source + "|z", position));
		rows.push(probes[5](/\|([^|]*)\|/g, "x|" + source + "|z", position));
	}
}
rows.push(probes[0]("x😀z", "1", "2", "0"), probes[0]("x😀z", "2", "3", "0"));
if (typeof process === "undefined" || process.env.MAL_SPAN_PRIMITIVE_ONLY !== "1") {
	for (const position of positions) rows.push(directPrimitives("a😀ba", position));
	for (const position of [undefined, NaN, Infinity, -Infinity, -0, 0, 1.8, -1.8]) {
		rows.push(directPrimitives("a😀ba", position));
		rows.push(primitiveSlice("a😀ba", undefined, undefined, position));
		rows.push(primitiveSubstring("ababa", undefined, undefined, position));
		rows.push(primitiveSubstr("ababa", undefined, undefined, position));
	}
	rows.push(
		primitiveSplit("missing", null),
		primitiveCapture(/x(a)?/, "x", "0"),
		primitiveCapture(/never/, "x", false),
	);
	const effects = [];
	const receiver = {
		toString() {
			effects.push("receiver");
			collect();
			return "ababa";
		},
	};
	const needle = {
		get [Symbol.match]() {
			effects.push("match");
			collect();
			return false;
		},
		toString() {
			effects.push("needle");
			collect();
			return "a";
		},
	};
	rows.push(String.prototype.includes.call(receiver, needle, "1"), effects.join(","));
	rows.push(
		String.prototype.lastIndexOf.call(receiver, needle, "NaN"),
		effects.join(","),
	);
	const start = {
		valueOf() {
			effects.push("start");
			collect();
			return 1;
		},
	};
	const end = {
		valueOf() {
			effects.push("end");
			collect();
			return 5;
		},
	};
	const position = {
		valueOf() {
			effects.push("position");
			collect();
			return 1;
		},
	};
	rows.push(primitiveSlice("x😀abz", start, end, position), effects.join(","));
	for (const rejected of [1n, Symbol("position")]) {
		for (const probe of [
			() => primitiveSlice("abc", rejected, "3", "0"),
			() => primitiveSubstring("abc", "0", rejected, "0"),
			() => primitiveSubstr("abc", "0", "3", rejected),
			() => primitiveSlice("abc", "0", "3", rejected),
		]) {
			try {
				probe();
			} catch (error) {
				rows.push(error.name);
			}
		}
	}
	const throwing = {
		valueOf() {
			effects.push("throw");
			throw new RangeError("position");
		},
	};
	try {
		primitiveSubstring("abc", throwing, end, "0");
	} catch (error) {
		rows.push(error.name, effects.join(","));
	}
	if (typeof process === "undefined" || process.env.MAL_SPAN_MUTABLE !== "locked") {
		const original = String.prototype.charAt;
		const changing = {
			valueOf() {
				effects.push("change");
				String.prototype.charAt = () => "changed";
				collect();
				return 1;
			},
		};
		try {
			rows.push(primitiveSlice("abc", "0", "3", changing), effects.join(","));
		} finally {
			String.prototype.charAt = original;
		}
	}
}
console.log(
	JSON.stringify(rows, (_key, value) =>
		value === undefined
			? "undefined"
			: typeof value === "number" && Number.isNaN(value)
				? "NaN"
				: value,
	),
);
