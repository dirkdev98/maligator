import { runRuntimeGapCase } from "../case-runner.mjs";
function output(source, search, replacement, escape) {
	const field = source.split("|")[1];
	const part = field.trim();
	const out = part.replaceAll(search, replacement);
	if (escape) return part;
	return out;
}
function run(scale) {
	const values = [
		"id| 123😀123 |end",
		"id| falsefalse |end",
		"id| nullnull |end",
		"id| 99999999999999999999 |end",
	];
	const searches = [123, false, null, 99999999999999999999n],
		replacements = [false, 123, null, 12345678901234567890n];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const out = output(
			values[i % 4],
			searches[i % 4],
			replacements[i % 4],
			(i & 63) === 0,
		);
		checksum = (checksum + out.length + out.charCodeAt(out.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-replace-primitives", run);
