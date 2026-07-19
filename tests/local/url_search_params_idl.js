const results = [];

function check(name, ok) {
	results.push([name, !!ok]);
}

function eq(name, got, want) {
	check(name + " (got " + JSON.stringify(got) + ")", got === want);
}

function throwsTypeError(name, fn) {
	let threw = false;
	try {
		fn();
	} catch (error) {
		threw = error instanceof TypeError;
	}
	check(name, threw);
}

const proto = URLSearchParams.prototype;

// Every prototype operation performs its receiver brand check at the boundary.
throwsTypeError("brand get", () => proto.get.call({}, "x"));
throwsTypeError("brand getAll", () => proto.getAll.call({}, "x"));
throwsTypeError("brand has", () => proto.has.call({}, "x"));
throwsTypeError("brand append", () => proto.append.call({}, "x", "1"));
throwsTypeError("brand set", () => proto.set.call({}, "x", "1"));
throwsTypeError("brand delete", () => proto.delete.call({}, "x"));
throwsTypeError("brand sort", () => proto.sort.call({}));
throwsTypeError("brand toString", () => proto.toString.call({}));
throwsTypeError("brand forEach", () => proto.forEach.call({}, () => {}));
throwsTypeError("brand entries", () => proto.entries.call({}));
throwsTypeError("brand keys", () => proto.keys.call({}));
throwsTypeError("brand values", () => proto.values.call({}));
const sizeGetter = Object.getOwnPropertyDescriptor(proto, "size").get;
throwsTypeError("brand size", () => sizeGetter.call({}));

// Required arguments are distinguished from present arguments whose value is undefined.
throwsTypeError("get requires name", () => new URLSearchParams().get());
throwsTypeError("getAll requires name", () => new URLSearchParams().getAll());
throwsTypeError("has requires name", () => new URLSearchParams().has());
throwsTypeError("delete requires name", () => new URLSearchParams().delete());
throwsTypeError("append requires value", () => new URLSearchParams().append("x"));
throwsTypeError("set requires value", () => new URLSearchParams().set("x"));
throwsTypeError("forEach requires callback", () => new URLSearchParams().forEach());
throwsTypeError("forEach requires callable", () => new URLSearchParams().forEach(1));

const undefinedArgs = new URLSearchParams("x=1&x=undefined");
check("has omitted value", undefinedArgs.has("x"));
check("has explicit undefined", undefinedArgs.has("x", undefined));
check(
	"has explicit undefined differs from string",
	new URLSearchParams("x=1").has("x", undefined),
);
check("has filters value", !undefinedArgs.has("x", "missing"));
undefinedArgs.delete("x", undefined);
eq("delete explicit undefined", undefinedArgs.toString(), "");
undefinedArgs.delete("x");
eq("delete omitted value", undefinedArgs.toString(), "");

const explicitValues = new URLSearchParams(
	"nullish=null&nullish=keep&empty=&empty=keep&zero=0&zero=keep&boolean=false&boolean=keep",
);
check("has explicit null", explicitValues.has("nullish", null));
check("has explicit empty string", explicitValues.has("empty", ""));
check("has explicit zero", explicitValues.has("zero", 0));
check("has explicit false", explicitValues.has("boolean", false));
explicitValues.delete("nullish", null);
explicitValues.delete("empty", "");
explicitValues.delete("zero", 0);
explicitValues.delete("boolean", false);
eq(
	"delete preserves unrelated explicit values",
	explicitValues.toString(),
	"nullish=keep&empty=keep&zero=keep&boolean=keep",
);

const associated = new URL("https://example.test/?x=1&x=undefined&keep=1");
associated.searchParams.delete("x", undefined);
eq("delete explicit undefined updates associated URL", associated.search, "?keep=1");

// All DOMString-facing arguments use USVString conversion.
const loneSurrogate = "\uD800";
const replacement = "\uFFFD";
const usv = new URLSearchParams();
usv.append(loneSurrogate, loneSurrogate);
check("append USVString", usv.has(replacement, replacement));
eq("get USVString", usv.get(loneSurrogate), replacement);
check("getAll USVString", usv.getAll(loneSurrogate)[0] === replacement);
usv.set(loneSurrogate, "next" + loneSurrogate);
eq("set USVString", usv.get(replacement), "next" + replacement);
usv.delete(loneSurrogate, "next" + loneSurrogate);
eq("delete USVString", usv.toString(), "");
usv.append(
	{
		toString() {
			return "fresh" + loneSurrogate;
		},
	},
	"value",
);
check("object result USVString stays rooted", usv.has("fresh" + replacement, "value"));

// Name conversion precedes value conversion, and conversion failure is atomic.
let order = "";
const nameValue = {
	toString() {
		order += "n";
		return "x";
	},
};
const valueValue = {
	toString() {
		order += "v";
		return "2";
	},
};
const ordered = new URLSearchParams("x=1");
ordered.set(nameValue, valueValue);
eq("set conversion order", order, "nv");
eq("set converted result", ordered.toString(), "x=2");

const marker = { marker: true };
let sawMarker = false;
order = "";
const throwingValue = {
	toString() {
		order += "v";
		throw marker;
	},
};
try {
	ordered.append(nameValue, throwingValue);
} catch (error) {
	sawMarker = error === marker;
}
check("append preserves abrupt completion", sawMarker);
eq("append failure conversion order", order, "nv");
eq("append failure does not mutate", ordered.toString(), "x=2");

sawMarker = false;
order = "";
try {
	ordered.delete(nameValue, throwingValue);
} catch (error) {
	sawMarker = error === marker;
}
check("delete preserves abrupt completion", sawMarker);
eq("delete failure conversion order", order, "nv");
eq("delete failure does not mutate", ordered.toString(), "x=2");

sawMarker = false;
order = "";
try {
	ordered.set(nameValue, throwingValue);
} catch (error) {
	sawMarker = error === marker;
}
check("set preserves abrupt completion", sawMarker);
eq("set failure conversion order", order, "nv");
eq("set failure does not mutate", ordered.toString(), "x=2");

let valueConverted = false;
const throwingName = {
	toString() {
		throw marker;
	},
};
const observedValue = {
	toString() {
		valueConverted = true;
		return "2";
	},
};
try {
	ordered.has(throwingName, observedValue);
} catch (error) {
	check("has preserves name abrupt completion", error === marker);
}
check("has skips value after name failure", !valueConverted);

// Keep the existing Web IDL function lengths while adding optional value behavior.
eq("get length", proto.get.length, 1);
eq("getAll length", proto.getAll.length, 1);
eq("has length", proto.has.length, 1);
eq("append length", proto.append.length, 2);
eq("set length", proto.set.length, 2);
eq("delete length", proto.delete.length, 1);

// Exercise replacement, compaction, and append barriers with young strings.
const churn = new URLSearchParams();
for (let i = 0; i < 80; i++) {
	churn.append("k" + (i % 4), "v" + i);
}
churn.set("k1", "latest");
churn.delete("k2", "v2");
check("GC mutation paths", churn.has("k1", "latest") && !churn.has("k2", "v2"));

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
