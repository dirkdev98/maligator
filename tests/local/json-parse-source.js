const results = [];
const forceGc = globalThis.__mal_collect_garbage;

function check(name, condition) {
	results.push([name, !!condition]);
}

const visits = [];
const parsed = JSON.parse(
	'{"number":1.0e+2,"string":"a\\nb","nested":{"value":true}}',
	function (key, value, context) {
		forceGc();
		visits.push([key, context.source, Object.keys(context).join("|")]);
		return value;
	},
);
check(
	"primitive source preserves the exact token",
	parsed.number === 100 &&
		parsed.string === "a\nb" &&
		visits[0].join(":") === "number:1.0e+2:source" &&
		visits[1].join(":") === 'string:"a\\nb":source' &&
		visits[2].join(":") === "value:true:source",
);
check(
	"container contexts are empty ordinary objects",
	visits[3].join(":") === "nested::" && visits[4].join(":") === "::",
);

const forwardVisits = [];
const replacement = { added: "later" };
const forwarded = JSON.parse('{"first":1,"second":2}', function (key, value, context) {
	forwardVisits.push(key + ":" + String(context.source));
	if (key === "first") this.second = replacement;
	return this[key];
});
check(
	"forward replacements are traversed without stale source",
	forwardVisits.join("|") === "first:1|added:undefined|second:undefined|:undefined" &&
		forwarded.second === replacement,
);

const descriptor = Object.getOwnPropertyDescriptor(
	JSON.parse("0", function (key, value, context) {
		return key === "" ? context : value;
	}),
	"source",
);
check(
	"source is a default data property",
	descriptor.value === "0" &&
		descriptor.writable &&
		descriptor.enumerable &&
		descriptor.configurable,
);

let plainChecksum = 0;
for (let i = 0; i < 50; i++) {
	const plain = JSON.parse('{"items":[1,{"value":2},3],"label":"plain"}');
	forceGc();
	plainChecksum += plain.items[1].value + plain.label.length;
}
check("no-reviver parse survives collection", plainChecksum === 350);

const duplicates = JSON.parse(
	'{"first":1,"same":"old","middle":2,"same":"new","last":3}',
);
forceGc();
check(
	"duplicate names keep first insertion order and last value",
	Object.keys(duplicates).join("|") === "first|same|middle|last" &&
		duplicates.same === "new",
);

const protoMember = JSON.parse('{"before":1,"__proto__":{"owned":true},"after":2}');
forceGc();
const protoDescriptor = Object.getOwnPropertyDescriptor(protoMember, "__proto__");
check(
	"__proto__ is an own default data property",
	Object.getPrototypeOf(protoMember) === Object.prototype &&
		protoDescriptor.value.owned === true &&
		protoDescriptor.writable &&
		protoDescriptor.enumerable &&
		protoDescriptor.configurable,
);

const indexed = JSON.parse(
	'{"2":"two","named":"value","0":"zero","01":"leading","1":"one"}',
);
forceGc();
check(
	"canonical index keys use ordinary property ordering",
	Object.keys(indexed).join("|") === "0|1|2|named|01" &&
		indexed[0] === "zero" &&
		indexed[2] === "two" &&
		indexed["01"] === "leading",
);

function widthSource(count) {
	let source = "{";
	for (let i = 0; i < count; i++) {
		if (i !== 0) source += ",";
		source += '"field' + i + '":' + i;
	}
	return source + "}";
}

const width32 = JSON.parse(widthSource(32));
const width33 = JSON.parse(widthSource(33));
forceGc();
check(
	"32 and 33 member objects survive shaped boundary fallback",
	Object.keys(width32).length === 32 &&
		width32.field0 === 0 &&
		width32.field31 === 31 &&
		Object.keys(width33).length === 33 &&
		width33.field0 === 0 &&
		width33.field32 === 32,
);

let malformedNested = false;
try {
	JSON.parse('{"outer":{"first":1,"inner":{"value":2}},"tail":');
} catch (error) {
	malformedNested = error instanceof SyntaxError;
}
forceGc();
const afterMalformed = JSON.parse('{"outer":{"inner":{"value":3}}}');
check(
	"nested staged members are released after malformed input",
	malformedNested && afterMalformed.outer.inner.value === 3,
);

const duplicateReviverVisits = [];
const duplicateRevived = JSON.parse(
	'{"first":1,"same":2,"middle":3,"same":4}',
	function (key, value, context) {
		if (key !== "") {
			forceGc();
			duplicateReviverVisits.push(key + ":" + String(context.source));
		}
		return value;
	},
);
check(
	"reviver mode keeps duplicate order and last source context",
	duplicateReviverVisits.join("|") === "first:1|same:4|middle:3" &&
		duplicateRevived.same === 4,
);

const raw = JSON.rawJSON('{"items":[1,true]}');
forceGc();
check("raw JSON validation retains its source", raw.rawJSON === '{"items":[1,true]}');

const longNumberSource = "1" + "0".repeat(400);
check(
	"long numeric tokens parse without an implementation length limit",
	JSON.parse(longNumberSource) === Infinity &&
		JSON.rawJSON(longNumberSource).rawJSON === longNumberSource,
);
check("negative zero is preserved", Object.is(JSON.parse("-0"), -0));

let malformedNumbers = 0;
for (const source of ["-", "01", "1.", "1e", "1e+", "[-01]"]) {
	try {
		JSON.parse(source);
	} catch (error) {
		if (error instanceof SyntaxError) malformedNumbers++;
	}
}
check("number grammar rejects incomplete and leading-zero forms", malformedNumbers === 6);

if (results.every((entry) => entry[1])) {
	console.log("json-parse-source PASS");
} else {
	for (const entry of results) {
		if (!entry[1]) console.log("FAIL: " + entry[0]);
	}
	console.log("json-parse-source FAIL");
}
