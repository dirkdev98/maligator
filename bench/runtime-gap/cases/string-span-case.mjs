import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, escape) {
	const field = source.split("|")[1],
		token = field.trim();
	const lower = token.toLowerCase(),
		upper = token.toUpperCase();
	if (escape) return token;
	return lower + upper;
}
function run(scale) {
	const values = ["id| AbCd |end", "id| café |end", "id| µßÿ |end", "id| ΑΣ |end"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const output = classify(values[i % values.length], (i & 63) === 0);
		checksum =
			(checksum + output.length + output.charCodeAt(output.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-case", run);
