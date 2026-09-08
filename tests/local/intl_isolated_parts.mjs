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
console.log("RESULT 2/2");
