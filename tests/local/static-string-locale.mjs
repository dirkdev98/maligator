function equal(actual, expected) {
	if (actual !== expected) throw new Error(JSON.stringify({ actual, expected }));
}
function throws(run, name) {
	try {
		run();
	} catch (error) {
		equal(error.name, name);
		return;
	}
	throw new Error("missing " + name);
}
const enabled = typeof Intl !== "undefined";
function cases(text, locales) {
	return text.toLocaleLowerCase(locales) + "|" + text.toLocaleUpperCase(locales);
}
function preparedTurkic(text) {
	const source = String(text);
	return source.toLocaleLowerCase("tr") + "|" + source.toLocaleUpperCase("az");
}
function preparedLithuanian(text) {
	const source = String(text);
	return source.toLocaleLowerCase("lt") + "|" + source.toLocaleUpperCase("lt");
}
globalThis.cases = cases;
globalThis.preparedTurkic = preparedTurkic;
globalThis.preparedLithuanian = preparedLithuanian;
equal(preparedTurkic("Iıiİ"), enabled ? "ııii|IIİİ" : "iıii\u0307|IIIİ");
equal(
	preparedLithuanian("I\u0301 i\u0307"),
	enabled ? "i\u0307\u0301 i\u0307|I\u0301 I" : "i\u0301 i\u0307|I\u0301 I\u0307",
);
for (const locale of ["tr", "az", ["tr", "lt"]])
	equal(
		cases("I\u0323\u0307 I\u0301\u0307 iı", locale),
		enabled
			? "i\u0323 ı\u0301\u0307 iı|I\u0323\u0307 I\u0301\u0307 İI"
			: "i\u0323\u0307 i\u0301\u0307 iı|I\u0323\u0307 I\u0301\u0307 II",
	);
equal(
	cases("I\u0323\u0301 J\u0300 Į\u0301 Ì Í Ĩ", "lt"),
	enabled
		? "i\u0307\u0323\u0301 j\u0307\u0300 į\u0307\u0301 i\u0307\u0300 i\u0307\u0301 i\u0307\u0303|I\u0323\u0301 J\u0300 Į\u0301 Ì Í Ĩ"
		: "i\u0323\u0301 j\u0300 į\u0301 ì í ĩ|I\u0323\u0301 J\u0300 Į\u0301 Ì Í Ĩ",
);
for (const locales of ["en-US", "und", []])
	equal(cases("ΟΣ Straße \ud800", locales), "ος straße \ud800|ΟΣ STRASSE \ud800");
for (const [locales, name] of [
	[null, "TypeError"],
	[[1], "TypeError"],
	[[null], "TypeError"],
	[[Symbol()], "TypeError"],
	["bad_locale", "RangeError"],
	[["en", "bad_locale"], "RangeError"],
]) {
	if (enabled) throws(() => cases("I", locales), name);
	else equal(cases("I", locales), "i|I");
}
let events = "";
const result = String.prototype.toLocaleLowerCase.call(
	{
		toString() {
			events += "s";
			return "I";
		},
	},
	{
		get length() {
			events += "l";
			return 2;
		},
		get 0() {
			events += "a";
			return "tr";
		},
		get 1() {
			events += "b";
			return {
				toString() {
					events += "c";
					return "lt";
				},
			};
		},
	},
);
equal(result, enabled ? "ı" : "i");
equal(events, enabled ? "slabc" : "s");
events = "";
const locales = new Proxy(
	{ length: 2 },
	{
		has() {
			events += "h";
			throw new Error("has");
		},
		get(target, key) {
			events += "g";
			return target[key];
		},
	},
);
if (enabled) throws(() => cases("I", locales), "Error");
else equal(cases("I", locales), "i|I");
equal(events, enabled ? "gh" : "");

function genericCompare(a, b, locale, options) {
	return String(a).localeCompare(b, locale, options);
}
function preparedSwedish(a, b) {
	return String(a).localeCompare(String(b), "sv");
}
function preparedDeprecatedLocale(a, b) {
	return String(a).localeCompare(String(b), "sh");
}
function preparedNumeric(a, b) {
	return String(a).localeCompare(String(b), "en-US", { numeric: true });
}
function preparedBase(a, b) {
	return String(a).localeCompare(String(b), "de", {
		sensitivity: "base",
		caseFirst: "upper",
	});
}
function preparedCase(a, b) {
	return String(a).localeCompare(String(b), "lt", {
		sensitivity: "case",
		caseFirst: "lower",
		numeric: 1n,
	});
}
globalThis.genericCompare = genericCompare;
globalThis.preparedSwedish = preparedSwedish;
globalThis.preparedDeprecatedLocale = preparedDeprecatedLocale;
globalThis.preparedNumeric = preparedNumeric;
globalThis.preparedBase = preparedBase;
globalThis.preparedCase = preparedCase;
for (const [a, b] of [
	["ä", "z"],
	["a", "A"],
	["2", "10"],
	["e\u0301", "é"],
	["I", "ı"],
	["", ""],
	["😀\ud800", "😀\udc00"],
	["a".repeat(80) + "z", "a".repeat(80) + "é"],
]) {
	for (let repeat = 0; repeat < 3; repeat++) {
		equal(preparedSwedish(a, b), genericCompare(a, b, "sv"));
		equal(preparedDeprecatedLocale(a, b), genericCompare(a, b, "sh"));
		equal(preparedNumeric(a, b), genericCompare(a, b, "en-US", { numeric: true }));
		equal(
			preparedBase(a, b),
			genericCompare(a, b, "de", { sensitivity: "base", caseFirst: "upper" }),
		);
		equal(
			preparedCase(a, b),
			genericCompare(a, b, "lt", {
				sensitivity: "case",
				caseFirst: "lower",
				numeric: 1n,
			}),
		);
	}
}
events = "";
const collect = globalThis.__mal_collect_garbage;
if (typeof collect !== "function") throw new Error("locale fixture requires the GC hook");
const collationReceiver = {
	toString() {
		events += "receiver;";
		collect();
		return "a";
	},
};
const collationArgument = {
	toString() {
		events += "argument;";
		collect();
		return "b";
	},
};
String.prototype.localeCompare.call(collationReceiver, collationArgument, "sv");
equal(events, "receiver;argument;");
events = "";
String.prototype.localeCompare.call(collationReceiver, collationArgument, "sv", {
	get numeric() {
		events += "numeric;";
		collect();
		return true;
	},
});
equal(events, enabled ? "receiver;argument;numeric;" : "receiver;argument;");
const collationOptions = { numeric: false };
const collationMutator = {
	toString() {
		collationOptions.numeric = true;
		return "10";
	},
};
equal(
	String.prototype.localeCompare.call(collationMutator, "2", "en-US", collationOptions),
	enabled ? 1 : -1,
);
function invalidPreparedLocale(a, b) {
	return String.prototype.localeCompare.call(a, b, "bad_locale");
}
globalThis.invalidPreparedLocale = invalidPreparedLocale;
throws(() => invalidPreparedLocale(Symbol(), "a"), "TypeError");
throws(() => invalidPreparedLocale("a", Symbol()), "TypeError");
if (enabled) throws(() => invalidPreparedLocale("a", "b"), "RangeError");
else equal(invalidPreparedLocale("a", "b"), -1);

function privateCollationOptions(a, b) {
	return Object(
		String(a).localeCompare(
			String(b),
			"en-US",
			{
				numeric: true,
				unused: recordCollationEffect("property"),
			},
			recordCollationEffect("extra"),
		),
	).valueOf();
}
function recordCollationEffect(name) {
	events += name + ";";
	return 1;
}
globalThis.privateCollationOptions = privateCollationOptions;
events = "";
equal(privateCollationOptions("10", "2"), enabled ? 1 : -1);
equal(events, "property;extra;");
events = "";
throws(
	() =>
		privateCollationOptions(
			{
				toString() {
					events += "throw;";
					throw new URIError();
				},
			},
			"2",
		),
	"URIError",
);
equal(events, "throw;");

console.log("locale cases passed");
