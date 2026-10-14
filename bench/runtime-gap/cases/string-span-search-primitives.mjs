import { runRuntimeGapCase } from "../case-runner.mjs";
function search(source, needle, escape) {
	const field = source.split("|")[1];
	const part = field.trim();
	const a = part.indexOf(needle),
		b = part.lastIndexOf(needle);
	const c = part.includes(needle),
		d = part.startsWith(needle),
		e = part.endsWith(needle);
	if (escape) return part.length;
	return a + b + Number(c) + Number(d) + Number(e);
}
function run(scale) {
	const values = [
		"id| 123😀123 |end",
		"id| falsefalse |end",
		"id| nullnull |end",
		"id| 99999999999999999999 |end",
	];
	const needles = [123, false, null, 99999999999999999999n];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++)
		checksum += search(values[i % 4], needles[i % 4], (i & 63) === 0);
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-search-primitives", run);
