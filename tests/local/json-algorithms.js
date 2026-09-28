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

function expectRangeError(action, message) {
	let caught;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof RangeError, message);
	collect();
}

const depth = 1200;
const deepText = "[".repeat(depth) + "0" + "]".repeat(depth);
expectRangeError(
	() => JSON.parse(deepText),
	"deep parsing fails without overflowing native stack",
);
let deepReviverCalls = 0;
expectRangeError(
	() =>
		JSON.parse(deepText, (key, value) => {
			deepReviverCalls++;
			return value;
		}),
	"source-tracking parse unwinds partially built nodes",
);
check(deepReviverCalls === 0, "a failed parse never enters the reviver");
expectRangeError(() => JSON.rawJSON(deepText), "raw JSON depth is bounded");

const deepObjectText = '{"next":'.repeat(depth) + "0" + "}".repeat(depth);
expectRangeError(
	() => JSON.parse(deepObjectText),
	"deep staged objects have bounded native stack use",
);
expectRangeError(
	() => JSON.parse(deepObjectText, (key, value) => value),
	"deep source-tracking objects unwind safely",
);
const nearText = '{"next":'.repeat(480) + "0" + "}".repeat(480);
const nearObject = JSON.parse(nearText, (key, value) => value);
check(
	JSON.stringify(nearObject, (key, value) => value) === nearText,
	"nested objects below the depth limit preserve identity callbacks",
);
let deepObject = 0;
for (let i = 0; i < depth; i++) deepObject = { next: deepObject };
expectRangeError(
	() => JSON.stringify(deepObject, (key, value) => value),
	"generic object frames respect the native stack bound",
);

let chain = 0;
for (let i = 0; i < depth; i++) chain = [chain];
check(
	JSON.stringify(chain) === deepText,
	"plain compact serialization retains heap-frame depth support",
);
let identityCalls = 0;
expectRangeError(
	() =>
		JSON.stringify(chain, (key, value) => {
			identityCalls++;
			return value;
		}),
	"deep identity-replacer serialization fails safely",
);
check(
	identityCalls > 0 && identityCalls < depth,
	"depth failure bounds replacer traversal",
);

let lateGetterCalls = 0;
let late = {};
Object.defineProperty(late, "leaf", {
	enumerable: true,
	get() {
		lateGetterCalls++;
		return 1;
	},
});
for (let i = 0; i < depth; i++) late = [late];
expectRangeError(
	() => JSON.stringify(late),
	"late plain-path fallback has bounded stack use",
);
check(
	lateGetterCalls === 0,
	"speculation and depth failure invoke no unreachable getter",
);

let introducedCalls = 0;
expectRangeError(
	() =>
		JSON.parse('{"first":0,"later":1}', function (key, value) {
			introducedCalls++;
			if (key === "first") this.later = chain;
			return value;
		}),
	"reviver-introduced deep trees fail with rooted cleanup",
);
check(
	introducedCalls === 1,
	"reviver depth failure preserves postorder callback behavior",
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
console.log(failed ? "json-algorithms FAIL" : "json-algorithms PASS");
