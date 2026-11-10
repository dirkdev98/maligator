if (typeof Intl.ListFormat !== "undefined") throw new Error("ListFormat must be absent");
const relative = typeof Intl.RelativeTimeFormat === "function";
const formatter = relative
	? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
	: new Intl.DurationFormat("en");
const args = relative ? [-1, "day"] : [{ hours: 2, minutes: 3 }];
const parts = formatter.formatToParts(...args);
if (
	parts.length === 0 ||
	parts.map((part) => part.value).join("") !== formatter.format(...args)
) {
	throw new Error("formatToParts must reconstruct format output");
}
if (relative) {
	for (const unit of [
		"second",
		"minute",
		"hour",
		"day",
		"week",
		"month",
		"quarter",
		"year",
	]) {
		if (formatter.format(-0, unit) !== formatter.format(0, unit)) {
			throw new Error(`numeric:auto must ignore zero's sign for ${unit}`);
		}
	}
	const always = new Intl.RelativeTimeFormat("en", { numeric: "always" });
	if (
		always.format(-0, "day") !== "0 days ago" ||
		always.format(0, "day") !== "in 0 days"
	) {
		throw new Error("numeric:always must preserve zero's sign");
	}
}
console.log("RESULT 2/2");
