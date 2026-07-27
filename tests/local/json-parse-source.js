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

const raw = JSON.rawJSON('{"items":[1,true]}');
forceGc();
check("raw JSON validation retains its source", raw.rawJSON === '{"items":[1,true]}');

if (results.every((entry) => entry[1])) {
	console.log("json-parse-source PASS");
} else {
	for (const entry of results) {
		if (!entry[1]) console.log("FAIL: " + entry[0]);
	}
	console.log("json-parse-source FAIL");
}
