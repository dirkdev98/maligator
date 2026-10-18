const lines = [];
const samples = [
	"operation",
	"operatioN",
	"operations",
	"",
	"é",
	"é",
	"😀",
	"\ud83d",
	0,
	-0,
	Number.NaN,
	undefined,
	null,
	true,
	9,
	{ toString: () => "operation" },
	["operation"],
	Symbol("operation"),
	1n,
];
function slice(text, start, end) {
	return text.slice(start, end);
}
const built = [
	["op", "eration"].join(""),
	`${"opera"}${"tion"}`,
	slice("xxoperationyy", 2, 11),
	String.fromCharCode(..."operation".split("").map((c) => c.charCodeAt(0))),
	"operation".repeat(3).slice(9, 18),
	["", ""].join(""),
	"e" + "́",
	"\ud83d" + "\ude00",
];
function describe(value) {
	return typeof value === "symbol"
		? value.toString()
		: typeof value === "bigint"
			? `${value}n`
			: (JSON.stringify(value) ?? String(value));
}
function classify(value) {
	const marks = [];
	if (value === "operation") marks.push("operation");
	if (value !== "operation") marks.push("not-operation");
	if ("operation" === value) marks.push("reversed");
	if (value === "") marks.push("empty");
	if (value === "é") marks.push("composed");
	if (value === "é") marks.push("decomposed");
	if (value === "😀") marks.push("emoji");
	if (value === "9") marks.push("nine");
	return marks.join(",");
}
for (let round = 0; round < 3; round++) {
	for (const value of [...samples, ...built])
		lines.push(`${describe(value)} ${classify(value)}`);
}
let operations = 0;
for (let index = 0; index < 4000; index++) {
	const value = index % 4 === 0 ? built[index % 5] : samples[index % samples.length];
	if (value === "operation") operations++;
}
lines.push(`operations ${operations}`);
console.log(lines.join("\n"));
