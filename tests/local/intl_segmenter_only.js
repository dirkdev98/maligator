const segmenter = new Intl.Segmenter("en", { granularity: "word" });
const segments = [...segmenter.segment("one two")];
const segmentsPass =
	segments.length === 3 && segments[0].segment === "one" && segments[2].segment === "two";
const servicesPass =
	typeof Intl.Collator !== "undefined" ||
	typeof Intl.NumberFormat !== "undefined" ||
	typeof Intl.RelativeTimeFormat !== "undefined";

console.log(`RESULT ${segmentsPass && !servicesPass ? 2 : 0}/2`);
