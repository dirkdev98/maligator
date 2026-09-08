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
console.log("locale cases passed");
