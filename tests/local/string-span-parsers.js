const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
function collect() {
	if (typeof gc === "function") gc();
}
function parseRange(source, radix) {
	const integer = parseInt;
	const token = source.slice(1, -1);
	collect();
	return [integer(token, radix), Number.parseFloat(token), token.length];
}
function parseSplit(source, radix) {
	const token = source.split("|")[1];
	collect();
	return [Number.parseInt(token, radix), parseFloat(token), token.length];
}
function parseCapture(expression, source, radix) {
	const match = expression.exec(source);
	if (match === null) return null;
	const token = match[1];
	collect();
	return [parseInt(token, radix), Number.parseFloat(token)];
}
function parseNested(source, radix) {
	const parent = source.substring(1, source.length - 1);
	const token = parent.trim();
	collect();
	return [Number.parseInt(token, radix), parseFloat(token), token.length];
}
function parseNamespace(source, namespace, radix) {
	const token = source.slice(1, -1);
	return [namespace.parseInt(token, radix), token.length];
}
function parseBounded(source, start, end, radix) {
	const token = source.slice(start, end);
	return [parseInt(token, radix), parseFloat(token), token.length];
}
globalThis.spanParsers = {
	range: parseRange,
	split: parseSplit,
	regexp: parseCapture,
	nested: parseNested,
	bounded: parseBounded,
	namespace: parseNamespace,
};
const rows = [];
function record(value) {
	if (typeof value === "number")
		return Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value);
	if (Array.isArray(value)) return value.map(record);
	return value;
}
function output(value) {
	rows.push(record(value));
}
function assert(value, message) {
	if (!value) throw new Error(message);
}
const family = process.env.MAL_SPAN_PARSE_FAMILY;
const tokens = [
	"-0tail",
	"  +0x10tail",
	"\ufeff\u2003-12.5e+2tail",
	"1e+",
	"-Infinityx",
	"\ud80012",
	"1.25e309",
	".5\u0100",
	"",
];
const radices = [
	undefined,
	0,
	-0,
	NaN,
	Infinity,
	null,
	false,
	true,
	2,
	8,
	10,
	16,
	36,
	1,
	37,
	-2,
	16.9,
	4294967312,
	"16",
	" 0x10 ",
];
for (const name of family ? [family] : ["range", "split", "regexp", "nested"]) {
	const run = globalThis.spanParsers[name];
	for (const token of tokens)
		for (const radix of radices) {
			const source = name === "split" ? "id|" + token + "|end" : "[" + token + "]";
			output(
				name === "regexp" ? run(/^\[([\s\S]*)\]$/, source, radix) : run(source, radix),
			);
		}
}
if (!family) {
	let prefix = "";
	for (let i = 0; i < 150; i++) prefix += i % 2 ? "abcdefghi" : "\u0100abcdefgh";
	let token = "\ufeff-0.";
	for (let i = 0; i < 79; i++) token += "0";
	token += "1e+80trailing";
	const rope = prefix + token + "999999" + prefix;
	output(
		globalThis.spanParsers.bounded(rope, prefix.length, prefix.length + token.length, 10),
	);
	for (const [value, end] of [
		["[0x123]", 3],
		["[1e+9]", 3],
		["[-Infinityx]", 10],
		["[12\ud80034]", 4],
	])
		output(globalThis.spanParsers.bounded(value, 1, end, 0));
	output(globalThis.spanParsers.range("[9007199254740993]", 10));
	for (const value of tokens) output([parseInt(value, 0), Number.parseFloat(value)]);
	output(globalThis.spanParsers.regexp(/(x)?y/, "y", 10));
	output(globalThis.spanParsers.regexp(/(x)/, "y", 10));
	let calls = 0;
	const expression = /([0-9]+)/;
	expression.exec = function (source) {
		calls++;
		collect();
		return RegExp.prototype.exec.call(this, source);
	};
	output(globalThis.spanParsers.regexp(expression, "42", 10));
	assert(calls === 1, "regexp exec runs once");
	const events = [];
	const radix = {
		valueOf() {
			events.push("radix");
			collect();
			return 16;
		},
	};
	output(globalThis.spanParsers.range("[ff]", radix));
	assert(events.join() === "radix", "radix coercion runs once");
	for (const radix of [1n, Symbol("radix")]) {
		let thrown = false;
		try {
			globalThis.spanParsers.range("[12]", radix);
		} catch (error) {
			thrown = error instanceof TypeError;
		}
		assert(thrown, "throwing radix preserves TypeError");
	}
	const original = parseInt;
	const receiver = {
		slice() {
			events.push("slice");
			return {
				toString() {
					events.push("string");
					collect();
					return "20";
				},
			};
		},
	};
	events.length = 0;
	output(globalThis.spanParsers.range(receiver, radix));
	assert(
		events.join() === "slice,string,radix,string",
		"fallback converts source before radix and each parser converts once",
	);
	events.length = 0;
	const namespace = {
		get parseInt() {
			events.push("get-parser");
			collect();
			return original;
		},
	};
	output(globalThis.spanParsers.namespace("[ff]", namespace, radix));
	assert(
		events.join() === "get-parser,radix",
		"parser getter precedes radix coercion without replay",
	);

	if (process.env.MAL_SPAN_MUTABLE !== "locked") {
		const float = Number.parseFloat;
		try {
			globalThis.parseInt = function (value, radix) {
				events.push("override-int");
				return original(value, radix) + 7;
			};
			Number.parseFloat = function (value) {
				events.push("override-float");
				return float(value) + 9;
			};
			events.length = 0;
			output(globalThis.spanParsers.range("[12]", 10));
			assert(
				events.join() === "override-int,override-float",
				"captured parser overrides execute",
			);
		} finally {
			globalThis.parseInt = original;
			Number.parseFloat = float;
		}
		events.length = 0;
		const changing = {
			valueOf() {
				events.push("radix");
				globalThis.parseInt = () => 999;
				collect();
				return 10;
			},
		};
		try {
			output(globalThis.spanParsers.range("[24]", changing));
		} finally {
			globalThis.parseInt = original;
		}
		assert(events.join() === "radix", "callee captured before radix mutation");
	}
}
console.log(JSON.stringify(rows));
