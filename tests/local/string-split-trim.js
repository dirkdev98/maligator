function trimmedLengths(value, separator) {
	const fields = value.split(separator);
	let total = 0;
	for (let index = 0; index < fields.length; index++) {
		const part = fields[index].trim();
		total = (total * 33 + part.length) | 0;
	}
	return total;
}
const collect = globalThis.__mal_collect_garbage;
const inputs = [
	["", "|"],
	["| \t| a |", "|"],
	["\u2000😀\ud800\ufeff||\t\udc00 \u2029", "||"],
	[("\u2000" + "x".repeat(33000) + "\ufeff|").repeat(2), "|"],
	[(" \t" + "x".repeat(33000) + "\u2000").repeat(2), "x\u2000"],
];
const rows = [];
for (const [value, separator] of inputs) {
	if (typeof collect === "function") collect();
	const checksum = trimmedLengths(value, separator);
	if (typeof collect === "function") collect();
	rows.push([checksum, value.split(separator).map((field) => field.trim())]);
}
const changed = [];
if (process.env.MAL_SPLIT_POLICY === "mutable") {
	const split = String.prototype.split;
	const trim = String.prototype.trim;
	try {
		String.prototype.split = function () {
			return [" a ", " bc "];
		};
		changed.push(trimmedLengths("ignored", "|"));
		String.prototype.split = split;
		String.prototype.trim = function () {
			return "replacement";
		};
		changed.push(trimmedLengths("a|bb", "|"));
	} finally {
		String.prototype.split = split;
		String.prototype.trim = trim;
	}
	changed.push(
		trimmedLengths("a|bb", {
			[Symbol.split]() {
				return [" custom ", " protocol "];
			},
		}),
	);
}
console.log(JSON.stringify({ rows, changed }));
