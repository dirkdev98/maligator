import { runRuntimeGapCase } from "../case-runner.mjs";
function repairField(source, escape) {
	const field = source.split("|")[1],
		token = field.trim(),
		valid = token.isWellFormed(),
		output = token.toWellFormed();
	if (escape) return token;
	return valid ? output : output + "!";
}
function run(scale) {
	const values = [
		"id| café |end",
		"id| \ud800 |end",
		"id| \ud800\udc00 |end",
		"id| \udc00A\ud800 |end",
	];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const output = repairField(values[i % values.length], (i & 63) === 0);
		checksum =
			(checksum + output.length + output.charCodeAt(output.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-well-formed", run);
