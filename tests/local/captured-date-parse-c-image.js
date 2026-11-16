function captured(value) {
	return Date.parse(String(value));
}
let conversions = 0;
const parsed = captured({
	[Symbol.toPrimitive](hint) {
		if (hint !== "string") throw new Error("conversion hint");
		conversions++;
		Date.parse = () => 17;
		return "2020-02-29T12:34:56.789Z";
	},
});
if (parsed !== 1582979696789 || conversions !== 1 || Date.parse("later") !== 17)
	throw new Error("captured parser");
console.log("captured-date-parse-c-image PASS");
