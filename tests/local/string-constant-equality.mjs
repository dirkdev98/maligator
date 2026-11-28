const lines = [];
const samples = [
	"operation",
	"operatioN",
	"operations",
	"",
	"é",
	"é",
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
	new String("operation"),
	new String("RETURN"),
];
function slice(text, start, end) {
	return text.slice(start, end);
}
const long = "operation-".repeat(4);
const built = [
	["op", "eration"].join(""),
	`${"opera"}${"tion"}`,
	slice("xxoperationyy", 2, 11),
	String.fromCharCode(..."operation".split("").map((c) => c.charCodeAt(0))),
	"operation".repeat(3).slice(9, 18),
	["", ""].join(""),
	"e" + "́",
	"\ud83d" + "\ude00",
	Object.keys({ operation: 1 })[0],
	Object.keys(JSON.parse('{"RETURN":1}'))[0],
	"operation-".repeat(2) + "operation-".repeat(2),
	slice(`x${long}x`, 1, 41),
];
const kinds = [
	"RETURN",
	"THROW",
	"JUMP",
	"CALL",
	"boxed",
	"int32",
	"string",
	"number",
	"boolean",
	"",
	"RETURX",
	"JUMPS",
	"return",
];
const kindValues = [
	...kinds,
	...kinds.map((kind) => kind.split("").reverse().reverse().join("")),
	...kinds.map((kind) => Object.keys({ [kind]: 0 })[0]),
	new String("RETURN"),
	new String("boxed"),
	6,
	null,
	undefined,
	Symbol("JUMP"),
];
function describe(value) {
	const text =
		typeof value === "symbol"
			? value.toString()
			: typeof value === "bigint"
				? `${value}n`
				: (JSON.stringify(value) ?? String(value));
	return `${typeof value}:${text}`;
}
function classify(value) {
	const marks = [];
	if (value === "operation") marks.push("operation");
	if (value !== "operation") marks.push("not-operation");
	if ("operation" === value) marks.push("reversed");
	if (value === "") marks.push("empty");
	if (value === "é") marks.push("composed");
	if (value === "é") marks.push("decomposed");
	if (value === "😀") marks.push("emoji");
	if (value === "9") marks.push("nine");
	if (value === "operation-operation-operation-operation-") marks.push("long");
	return marks.join(",");
}
function isOperation(value) {
	return value === "operation";
}
function dispatch(kind) {
	if (kind === "RETURN") return 1;
	else if (kind === "THROW") return 2;
	else if (kind === "JUMP") return 3;
	else if (kind === "CALL") return 4;
	else if (kind === "boxed") return 5;
	else if (kind === "int32") return 6;
	else if (kind === "string") return 7;
	else if (kind === "number") return 8;
	else if (kind === "boolean") return 9;
	else if (kind === "") return 10;
	return 0;
}
function rooted(kind) {
	return kind === "boxed" || kind === "string";
}
function terminal(kind) {
	return kind === "RETURN" || kind === "THROW" || kind === "JUMP";
}
function scalar(kind) {
	return kind !== "boxed" && kind !== "string" && kind !== "RETURN";
}
for (let round = 0; round < 3; round++) {
	for (const value of [...samples, ...built])
		lines.push(`${describe(value)} ${classify(value)} ${isOperation(value)}`);
	for (const kind of kindValues)
		lines.push(
			`${describe(kind)} ${dispatch(kind)} ${rooted(kind)} ${terminal(kind)} ${scalar(kind)}`,
		);
}
let operations = 0;
for (let index = 0; index < 4000; index++) {
	const value = index % 4 === 0 ? built[index % 5] : samples[index % samples.length];
	if (value === "operation") operations++;
}
lines.push(`operations ${operations}`);
let dispatched = 0;
for (let index = 0; index < 4000; index++)
	dispatched += dispatch(kindValues[index % kindValues.length]);
lines.push(`dispatched ${dispatched}`);
console.log(lines.join("\n"));
