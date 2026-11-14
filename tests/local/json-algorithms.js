let failed = false;
const gc = globalThis.__mal_collect_garbage;

function check(condition, message) {
	if (!condition) {
		failed = true;
		console.log("FAIL: " + message);
	}
}

function collect() {
	if (typeof gc === "function") gc();
}

const depth = 1200;
const deepText = "[".repeat(depth) + "0" + "]".repeat(depth);
check(
	JSON.stringify(JSON.parse(deepText)) === deepText,
	"deep array parsing uses heap frames",
);
let deepReviverCalls = 0;
const deepRevived = JSON.parse(deepText, (key, value) => {
	deepReviverCalls++;
	return value;
});
check(
	JSON.stringify(deepRevived) === deepText && deepReviverCalls === depth + 1,
	"deep revivers visit every value in postorder",
);

const deepObjectText = '{"next":'.repeat(depth) + "0" + "}".repeat(depth);
check(
	JSON.stringify(JSON.parse(deepObjectText)) === deepObjectText,
	"deep object parsing uses heap frames",
);
const deepObject = JSON.parse(deepObjectText, (key, value) => value);
check(
	JSON.stringify(deepObject, (key, value) => value) === deepObjectText,
	"deep source-tracking objects retain identity callbacks",
);

let chain = 0;
for (let i = 0; i < depth; i++) chain = [chain];
check(
	JSON.stringify(chain) === deepText,
	"plain compact serialization retains heap-frame depth support",
);
let identityCalls = 0;
check(
	JSON.stringify(chain, (key, value) => {
		identityCalls++;
		return value;
	}) === deepText && identityCalls === depth + 1,
	"deep identity-replacer serialization visits each value once",
);
check(
	JSON.stringify(chain, ["next"]) === deepText,
	"deep serialization keeps array elements with a property allow-list",
);
const pretty = JSON.stringify(chain, null, " ");
check(
	pretty.length === depth * depth + 4 * depth + 1 &&
		JSON.stringify(JSON.parse(pretty)) === deepText,
	"deep pretty serialization retains indentation",
);

let lateGetterCalls = 0;
let late = {};
Object.defineProperty(late, "leaf", {
	enumerable: true,
	get() {
		lateGetterCalls++;
		collect();
		return 1;
	},
});
for (let i = 0; i < depth; i++) late = [late];
check(
	JSON.stringify(late) === "[".repeat(depth) + '{"leaf":1}' + "]".repeat(depth) &&
		lateGetterCalls === 1,
	"deep plain-path fallback preserves its prefix and calls a getter once",
);

let introducedCalls = 0;
const introduced = JSON.parse('{"first":0,"later":1}', function (key, value, context) {
	introducedCalls++;
	if (key === "first") this.later = chain;
	if (key === "0")
		check(context.source === undefined, "introduced values have no source context");
	return value;
});
check(
	introduced.later === chain && introducedCalls === depth + 3,
	"reviver-introduced deep trees preserve postorder callback behavior",
);

let malformedCalls = 0;
for (const invalid of [
	deepText.slice(0, -1),
	deepObjectText.slice(0, -1),
	"[".repeat(depth) + "0," + "]".repeat(depth),
]) {
	let caught;
	try {
		JSON.parse(invalid, (key, value) => {
			malformedCalls++;
			return value;
		});
	} catch (error) {
		caught = error;
	}
	check(caught instanceof SyntaxError, "malformed deep input reports a syntax error");
	collect();
}
check(malformedCalls === 0, "malformed deep input never enters the reviver");

const diagnosticCases = [
	["{     ", "Expected property name or '}' in JSON at position 6 (line 1 column 7)"],
	["[     ", "Unexpected end of JSON input"],
	['"     ', "Unterminated string in JSON at position 6 (line 1 column 7)"],
	[
		"[1,2,3]?",
		"Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
	],
	[' "Invalid', "Unterminated string in JSON at position 9 (line 1 column 10)"],
	['"😀', "Unterminated string in JSON at position 3 (line 1 column 4)"],
	['"\\', "Unexpected end of JSON input"],
	[
		'{"a":1,}',
		"Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
	],
	["{\nbad", "Expected property name or '}' in JSON at position 2 (line 2 column 1)"],
	["{\rbad", "Expected property name or '}' in JSON at position 2 (line 2 column 1)"],
	["{\r\nbad", "Expected property name or '}' in JSON at position 3 (line 2 column 1)"],
	[
		"[".repeat(32) + "{",
		"Expected property name or '}' in JSON at position 33 (line 1 column 34)",
	],
	[
		"[".repeat(32) + '{"a":0,',
		"Expected double-quoted property name in JSON at position 39 (line 1 column 40)",
	],
	["[".repeat(32), "Unexpected end of JSON input"],
	[
		" ".repeat(256) + '"😀',
		"Unterminated string in JSON at position 259 (line 1 column 260)",
	],
];
for (const [text, expected] of diagnosticCases) {
	for (const source of [text, makeRope(text, 31, "right")]) {
		for (const reviver of [undefined, (key, value) => value]) {
			let caught;
			try {
				JSON.parse(source, reviver);
			} catch (error) {
				caught = error;
			}
			check(
				caught instanceof SyntaxError && caught.message === expected,
				"JSON parse diagnostic: " + expected,
			);
		}
	}
}

function wrapDeep(value) {
	for (let i = 0; i < 64; i++) value = [value];
	return value;
}
function unwrapDeep(value) {
	for (let i = 0; i < 64; i++) value = value[0];
	return value;
}

const proxyTrace = [];
const proxyTarget = { first: 1, later: 2 };
const proxy = new Proxy(proxyTarget, {
	ownKeys(target) {
		proxyTrace.push("keys");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		proxyTrace.push("desc:" + key);
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
	get(target, key) {
		proxyTrace.push("get:" + key);
		if (key === "first") delete target.later;
		return Reflect.get(target, key);
	},
});
const proxyText = JSON.stringify(wrapDeep(proxy), (key, value) =>
	key === "later" ? 7 : value,
);
check(
	JSON.stringify(unwrapDeep(JSON.parse(proxyText))) === '{"first":1,"later":7}' &&
		proxyTrace.join("|") === "get:toJSON|keys|desc:first|desc:later|get:first|get:later",
	"deep generic serialization snapshots proxy descriptors before value getters",
);

let toJsonCalls = 0;
const transformed = wrapDeep({
	toJSON(key) {
		toJsonCalls++;
		collect();
		return { kept: key, dropped: undefined };
	},
});
check(
	JSON.stringify(
		unwrapDeep(JSON.parse(JSON.stringify(transformed, (key, value) => value))),
	) === '{"kept":"0"}' && toJsonCalls === 1,
	"deep serialization transforms each child once and omits undefined members",
);

const filtered = JSON.stringify(wrapDeep({ first: 1, later: { first: 2, extra: 3 } }), [
	"later",
	"first",
]);
check(
	JSON.stringify(unwrapDeep(JSON.parse(filtered))) === '{"later":{"first":2},"first":1}',
	"deep object serialization retains property-list order",
);

const deepMutationTrace = [];
const deepMutation = JSON.parse(
	JSON.stringify(wrapDeep({ first: 0, same: 2, later: 3 })),
	function (key, value, context) {
		if (key === "first" || key === "same" || key === "later" || key === "added")
			deepMutationTrace.push(key + ":" + String(context.source));
		if (key === "first") {
			delete this.same;
			this.later = { added: 4 };
		}
		if (key === "added") collect();
		return value;
	},
);
check(
	deepMutationTrace.join("|") ===
		"first:0|same:undefined|added:undefined|later:undefined" &&
		!("same" in unwrapDeep(deepMutation)) &&
		unwrapDeep(deepMutation).later.added === 4,
	"deep revivers retain snapshots and invalidate replaced source contexts",
);

const revisited = { first: 0 };
let cyclicVisits = 0;
Object.defineProperty(revisited, "later", {
	enumerable: true,
	get() {
		cyclicVisits++;
		return cyclicVisits < 3 ? revisited : 1;
	},
});
JSON.parse('{"first":0,"later":1}', function (key, value) {
	if (key === "first" && this !== revisited) this.later = wrapDeep(revisited);
	return value;
});
check(
	cyclicVisits === 3,
	"revivers allow repeated objects whose getters finish traversal",
);

const marker = new Error("JSON callback marker");
let markerCaught;
let markerCalls = 0;
try {
	JSON.parse('{"a":{"b":{"c":1}},"later":2}', (key, value) => {
		markerCalls++;
		collect();
		throw marker;
	});
} catch (error) {
	markerCaught = error;
}
check(
	markerCaught === marker && markerCalls === 1,
	"reviver throws stop callbacks and release source records",
);

const shared = { leaf: 7 };
const dag = [shared, shared, { nested: shared }];
let dagVisits = 0;
check(
	JSON.stringify(dag, (key, value) => {
		if (key === "leaf") {
			dagVisits++;
			collect();
		}
		return value;
	}) === '[{"leaf":7},{"leaf":7},{"nested":{"leaf":7}}]' && dagVisits === 3,
	"active-path membership permits repeated shared children across GC",
);
shared.cycle = dag;
let cycleCaught;
try {
	JSON.stringify(dag, (key, value) => value);
} catch (error) {
	cycleCaught = error;
}
check(cycleCaught instanceof TypeError, "active-path membership rejects cycles");
delete shared.cycle;
check(
	JSON.stringify(dag) === '[{"leaf":7},{"leaf":7},{"nested":{"leaf":7}}]',
	"cycle failure does not poison later calls",
);

let wideSource = '{"0":-0,"01":1,"é":2';
const width = 512;
for (let i = 0; i < width; i++) wideSource += ',"field' + i + '":' + i;
wideSource += ',"0":-0.0,"\\u00e9":2.0,"field0":0e0,"field511":5.11e2}';
const stagedWide = JSON.parse(wideSource);
check(
	Object.keys(stagedWide).length === width + 3 &&
		Object.is(stagedWide[0], -0) &&
		stagedWide.field511 === 511 &&
		JSON.stringify(stagedWide) ===
			JSON.stringify(JSON.parse(wideSource, (key, value) => value)),
	"staged member growth preserves duplicate keys and insertion order",
);
const stagedSmall = JSON.parse('{"a":{"keep":1},"b":[2],"a":{"last":3},"c":4}');
collect();
check(
	Object.keys(stagedSmall).join(",") === "a,b,c" &&
		stagedSmall.a.last === 3 &&
		stagedSmall.b[0] === 2 &&
		stagedSmall.c === 4,
	"inline staged members preserve nested values and the final duplicate",
);
let wideCalls = 0;
let duplicateSources = "";
const wide = JSON.parse(wideSource, function (key, value, context) {
	wideCalls++;
	if (key === "0" || key === "é" || key === "field0" || key === "field511") {
		duplicateSources += key + ":" + context.source + "|";
		collect();
	}
	return value;
});
check(
	wideCalls === width + 4 &&
		Object.is(wide[0], -0) &&
		wide.field511 === 511 &&
		duplicateSources === "0:-0.0|é:2.0|field0:0e0|field511:5.11e2|",
	"wide canonical-key source index preserves the final duplicate token and first key order",
);

const mutationTrace = [];
const changed = JSON.parse(
	'{"first":0,"same":2,"later":3,"same":2.0}',
	function (key, value, context) {
		mutationTrace.push(key + ":" + String(context.source));
		if (key === "first") {
			delete this.same;
			this.later = { added: 4 };
		}
		return value;
	},
);
check(
	mutationTrace.join("|") ===
		"first:0|same:undefined|added:undefined|later:undefined|:undefined" &&
		!("same" in changed) &&
		changed.later.added === 4,
	"source indexing preserves snapshot order and invalidates replaced or deleted values",
);

function makeRope(text, chunkSize, direction) {
	const pieces = [];
	for (let i = 0; i < text.length; i += chunkSize)
		pieces.push(text.slice(i, i + chunkSize));
	if (direction === "balanced") {
		let level = pieces;
		while (level.length > 1) {
			const next = [];
			for (let i = 0; i < level.length; i += 2)
				next.push(level[i] + (level[i + 1] || ""));
			level = next;
		}
		return level[0];
	}
	let result = "";
	if (direction === "left") {
		for (let i = 0; i < pieces.length; i++) result += pieces[i];
	} else {
		for (let i = pieces.length - 1; i >= 0; i--) result = pieces[i] + result;
	}
	return result;
}

const tokens = [
	"-0",
	"-0.0",
	"0e-999",
	"-1e-999",
	"9007199254740991",
	"9007199254740993",
	"-2147483649",
	"1.234567890123456789e+20",
	"1" + "0".repeat(180),
	'"' + "Latin-é".repeat(30) + '"',
	'"' + "wide-Ā".repeat(30) + '"',
	'"' + "prefix".repeat(30) + '\\n\\ud800\\udfff"',
];
const tokenText = "[" + tokens.join(",") + "]";
const expectedValues = JSON.parse(tokenText);
for (const direction of ["balanced", "left", "right"]) {
	for (const chunkSize of [31, 64, 127]) {
		let sourceCalls = 0;
		const parsed = JSON.parse(
			makeRope(tokenText, chunkSize, direction),
			function (key, value, context) {
				if (key !== "") {
					check(
						context.source === tokens[+key],
						"rope token source: " + direction + ":" + chunkSize + ":" + key,
					);
					sourceCalls++;
				}
				return value;
			},
		);
		check(sourceCalls === tokens.length, "rope token callback count");
		for (let i = 0; i < tokens.length; i++)
			check(
				Object.is(parsed[i], expectedValues[i]),
				"rope token value: " + direction + ":" + chunkSize + ":" + i,
			);
	}
}

// Exercise each exceptional unit in every lane of the UTF16 quote scan, including
// the scalar prefix and the first two word blocks. Join gives a flat wide string.
const escapedUnits = [
	[34, '\\"'],
	[92, "\\\\"],
	[0xd800, "\\ud800"],
	[0xdbff, "\\udbff"],
	[0xdc00, "\\udc00"],
	[0xdfff, "\\udfff"],
];
for (let unit = 0; unit < 32; unit++) {
	const short = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
	escapedUnits.push([unit, short[unit] || "\\u00" + unit.toString(16).padStart(2, "0")]);
}
for (let offset = 0; offset < 12; offset++) {
	const prefix = "Ā".repeat(offset);
	const suffix = "Ā".repeat(12);
	for (const [unit, escaped] of escapedUnits) {
		const text = [prefix, String.fromCharCode(unit), suffix].join("");
		check(
			JSON.stringify(text) === '"' + prefix + escaped + suffix + '"',
			"wide quote escape at word lane: " + offset + ":" + unit,
		);
	}
	const paired = [prefix, "\ud83d\ude00", suffix].join("");
	check(
		JSON.stringify(paired) === '"' + paired + '"',
		"wide quote keeps surrogate pairs",
	);
}

// Exhaust both cache admission limits while ordinary data keeps the iterative
// traversal. The final shape includes ignored properties and omitted values.
const diverse = [];
const diverseExpected = [];
for (let i = 0; i < 300; i++) {
	const key = "unique" + i;
	const object = {};
	object[key] = i;
	diverse.push(object);
	diverseExpected.push('{"' + key + '":' + i + "}");
}
const uncached = { visible: 7, omitted: undefined };
Object.defineProperty(uncached, "hidden", { value: 8 });
uncached[Symbol("ignored")] = 9;
diverse.push(uncached);
diverseExpected.push('{"visible":7}');
check(
	JSON.stringify(diverse) === "[" + diverseExpected.join(",") + "]",
	"uncached eligible shapes preserve ignored and omitted property semantics",
);
const sharedKeyRows = [];
const sharedKeyExpected = [];
for (let i = 0; i < 300; i++) {
	const row = {};
	row['shared"\t'] = i;
	row["unique-" + i] = i + 1;
	if (i >= 3) row["Ā\ud800key"] = i + 2;
	sharedKeyRows.push(row);
	sharedKeyExpected.push(
		'{"shared\\"\\t":' +
			i +
			',"unique-' +
			i +
			'":' +
			(i + 1) +
			(i >= 3 ? ',"Ā\\ud800key":' + (i + 2) : "") +
			"}",
	);
}
check(
	JSON.stringify(sharedKeyRows) === "[" + sharedKeyExpected.join(",") + "]",
	"escaped keys shared across unique shapes survive width promotion and cache exhaustion",
);
const wideKey = "Ā".repeat(40000);
const hugeKeyObject = {};
hugeKeyObject[wideKey] = 1;
const hugeKeyExpected = '{"' + wideKey + '":1}';
check(
	JSON.stringify([hugeKeyObject, hugeKeyObject]) ===
		"[" + hugeKeyExpected + "," + hugeKeyExpected + "]",
	"key encodings larger than the cache budget remain serializable and repeatable",
);
let uncachedGetterCalls = 0;
diverse.push({
	get final() {
		uncachedGetterCalls++;
		return 11;
	},
});
check(
	JSON.stringify(diverse) === "[" + diverseExpected.join(",") + ',{"final":11}]' &&
		uncachedGetterCalls === 1,
	"late fallback after cache exhaustion invokes the getter exactly once",
);
const prototypeRows = [];
for (let i = 0; i < 300; i++) prototypeRows.push(Object.create({ inherited: i }));
check(
	JSON.stringify(prototypeRows) === "[" + "{},".repeat(299) + "{}]",
	"bounded prototype proof eviction preserves output",
);

for (const token of ["-", "01", "1.", "1e", "1e+", "1e-", "--1", "1.2.3"]) {
	let caught;
	try {
		JSON.parse(makeRope("[" + " ".repeat(200) + token + "]", 31, "right"));
	} catch (error) {
		caught = error;
	}
	check(caught instanceof SyntaxError, "malformed rope number: " + token);
}
collect();
check(
	JSON.stringify(JSON.parse('{"after":42}')) === '{"after":42}',
	"JSON remains usable after abrupt completion",
);
// Cached keys of one length that differ in a single position stay distinct.
let distinctKeys = true;
for (let length = 1; length <= 25; length++) {
	for (let position = 0; position < length; position++) {
		const base = "k".repeat(length);
		const other = base.slice(0, position) + "q" + base.slice(position + 1);
		for (let round = 0; round < 2; round++) {
			const parsed = JSON.parse('{"' + base + '":1,"' + other + '":2}');
			distinctKeys &&= parsed[base] === 1 && parsed[other] === 2;
			distinctKeys &&= Object.keys(parsed).join() === base + "," + other;
		}
	}
}
check(distinctKeys, "cached keys compare every byte");
// Records whose members include scalar records serialize like the member loop.
const nestedRecords = Array.from({ length: 3 }, (_, index) => ({
	id: "p" + index,
	views: index * 7,
	author: { name: "a" + index, rank: index, active: index !== 1, note: null },
}));
check(
	JSON.stringify(nestedRecords) ===
		'[{"id":"p0","views":0,"author":{"name":"a0","rank":0,"active":true,"note":null}},' +
			'{"id":"p1","views":7,"author":{"name":"a1","rank":1,"active":false,"note":null}},' +
			'{"id":"p2","views":14,"author":{"name":"a2","rank":2,"active":true,"note":null}}]',
	"nested scalar records",
);
check(
	JSON.stringify({ id: 1, inner: { text: 'a"b', wide: "é€" } }) ===
		'{"id":1,"inner":{"text":"a\\"b","wide":"é€"}}',
	"nested records with escapes and wide strings",
);
check(
	JSON.stringify({ id: 1, inner: { b: 2 } }, null, 2) ===
		'{\n  "id": 1,\n  "inner": {\n    "b": 2\n  }\n}',
	"indented nested records",
);
class TaggedRecord {
	constructor() {
		this.value = 1;
	}
	toJSON() {
		return "tagged";
	}
}
check(
	JSON.stringify({ id: 1, tag: new TaggedRecord() }) === '{"id":1,"tag":"tagged"}',
	"inherited toJSON on a nested record",
);
const selfRecord = { id: 1, inner: null };
selfRecord.inner = selfRecord;
const ancestor = { item: null };
ancestor.item = { id: 1, up: ancestor };
for (const [label, value] of [
	["self", selfRecord],
	["ancestor", ancestor],
]) {
	let caught;
	try {
		JSON.stringify(value);
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, "nested record cycle through " + label);
}
// One unit above Latin-1 makes the whole document UTF-16; its keys, small integers and
// escaped strings keep their meaning on the narrow fast paths.
const wideDocument =
	'{"name":"item \\"0\\"\\n café 😀","zero":-0,"big":123456789012345678,"neg":-42,' +
	'"esc":"\\u00e9\\ud83d\\ude00\\/\\b\\f\\r\\t","emoji":"😀"}';
for (let round = 0; round < 2; round++) {
	const wide = JSON.parse(wideDocument);
	check(
		wide.name === 'item "0"\n café 😀' &&
			Object.is(wide.zero, -0) &&
			wide.big === 123456789012345678 &&
			wide.neg === -42 &&
			wide.esc === "é😀/\b\f\r\t" &&
			Object.keys(wide).join() === "name,zero,big,neg,esc,emoji",
		"UTF-16 document values on round " + round,
	);
}
for (const malformed of [
	'{"e":"😀","a":"\\x"}',
	'{"e":"😀","a":"\\u12G4"}',
	'{"e":"😀","a":"a\nb"}',
]) {
	let caught;
	try {
		JSON.parse(malformed);
	} catch (error) {
		caught = error;
	}
	check(
		caught instanceof SyntaxError,
		"malformed UTF-16 document " + JSON.stringify(malformed),
	);
}
console.log(failed ? "json-algorithms FAIL" : "json-algorithms PASS");
